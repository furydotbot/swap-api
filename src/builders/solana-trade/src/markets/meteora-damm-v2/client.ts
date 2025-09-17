import { Connection, PublicKey, TransactionInstruction, LAMPORTS_PER_SOL, ComputeBudgetProgram } from '@solana/web3.js';
import BN from 'bn.js';
import { CpAmm, getTokenDecimals, getTokenProgram } from '@meteora-ag/cp-amm-sdk';
import { mints } from '../../helpers/constants';
import { makePairKey, readPair, writePair, readGlobal, writeGlobal } from '../../helpers/disk-cache';

type DammV2Pool = {
  pool_address: string;
  token_a_mint: string;
  token_b_mint: string;
  token_a_amount?: number | string;
  token_b_amount?: number | string;
  liquidity?: string | number;
  tvl?: number | string;
};

export class MeteoraDammV2Client {
  private readonly connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  private async queryPools(params: Record<string, string | number | boolean | undefined>): Promise<DammV2Pool[]> {
    const base = 'https://dammv2-api.meteora.ag/pools';
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const res = await fetch(`${base}?${qs}`, { method: 'GET' });
    if (!res.ok) throw new Error(`DAMM v2 API status ${res.status}`);
    const json: any = await res.json();
    const items: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    return items as DammV2Pool[];
  }

  private async fetchPoolsForTokenPair(tokenMint: string, otherMint: string): Promise<DammV2Pool[]> {
    // Query both directions explicitly; API uses field-specific filters
    const limit = 300;
    const [aThenB, bThenA] = await Promise.all([
      this.queryPools({ token_a_mint: tokenMint, token_b_mint: otherMint, limit }),
      this.queryPools({ token_a_mint: otherMint, token_b_mint: tokenMint, limit }),
    ]);
    // Deduplicate by pool address
    const map = new Map<string, DammV2Pool>();
    for (const it of [...aThenB, ...bThenA]) {
      if (it?.pool_address) map.set(it.pool_address, it);
    }
    return Array.from(map.values());
  }

  private async fetchAllPoolsPaginated(): Promise<DammV2Pool[]> {
    const limit = 500;
    let offset = 0;
    const results: DammV2Pool[] = [];
    while (true) {
      const batch = await this.queryPools({ limit, offset });
      if (!Array.isArray(batch) || batch.length === 0) break;
      results.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
    // Deduplicate by pool address
    const map = new Map<string, DammV2Pool>();
    for (const it of results) if (it?.pool_address) map.set(it.pool_address, it);
    return Array.from(map.values());
  }

  private chooseBestPool(items: DammV2Pool[], targetMint: string, wsolMint: string): DammV2Pool | null {
    const subset = items.filter((it) => {
      const mx = it?.token_a_mint;
      const my = it?.token_b_mint;
      return !!mx && !!my && ((mx === targetMint && my === wsolMint) || (my === targetMint && mx === wsolMint));
    });
    if (subset.length === 0) return null;
    const best = subset.reduce((acc: any, it: DammV2Pool) => {
      const tokenIsA = it.token_a_mint === targetMint;
      const tokenReserveRaw = tokenIsA ? it.token_a_amount : it.token_b_amount;
      const tokenReserve = typeof tokenReserveRaw === 'string' ? parseFloat(tokenReserveRaw) : Number(tokenReserveRaw ?? 0);
      const tvlRaw = it.tvl ?? it.liquidity;
      const tvl = typeof tvlRaw === 'string' ? parseFloat(tvlRaw) : Number(tvlRaw ?? 0);
      const score = tokenReserve > 0 ? tokenReserve : tvl;
      if (!acc || score > acc.score) return { it, score };
      return acc;
    }, null as null | { it: DammV2Pool; score: number });
    return best?.it ?? null;
  }

  private async findPoolAddressForMint(mint: PublicKey): Promise<PublicKey> {
    const token = mint.toBase58();
    const wsol = mints.WSOL;
    const pairKey = makePairKey(token, wsol);
    const cached = readPair('damm_v2', pairKey);
    if (cached?.address) return new PublicKey(cached.address);

    // Try global cache first
    let global = readGlobal('damm_v2');
    if (!global) {
      try {
        global = await this.fetchAllPoolsPaginated();
        writeGlobal('damm_v2', global);
      } catch (_e) {
        global = null;
      }
    }
    if (global) {
      const bestFromGlobal = this.chooseBestPool(global as DammV2Pool[], token, wsol);
      if (bestFromGlobal?.pool_address) {
        writePair('damm_v2', pairKey, bestFromGlobal.pool_address);
        return new PublicKey(bestFromGlobal.pool_address);
      }
    }

    // Fallback: filtered query for the pair
    const items = await this.fetchPoolsForTokenPair(token, wsol);
    const best = this.chooseBestPool(items, token, wsol);
    if (!best?.pool_address) throw new Error('Meteora DAMM v2 pool for mint-WSOL not found');
    writePair('damm_v2', pairKey, best.pool_address);
    return new PublicKey(best.pool_address);
  }

  private stripNonEssentialInstructions(ixs: TransactionInstruction[]): TransactionInstruction[] {
    return ixs.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId));
  }

  private toPercentFromFraction(slippage: number): number {
    // input slippage in [0,1]; convert to percent in [0,100]
    const pct = Math.max(0, Math.min(100, slippage * 100));
    // round to 2 decimals per SDK note
    return Math.round(pct * 100) / 100;
  }

  async getBuyInstructions(params: { mintAddress: PublicKey; wallet: PublicKey; solAmount: number; slippage: number; poolAddress?: PublicKey; }): Promise<TransactionInstruction[]> {
    const { mintAddress, wallet, solAmount, slippage, poolAddress } = params;
    const poolPk = poolAddress ?? await this.findPoolAddressForMint(mintAddress);
    const sdk = new CpAmm(this.connection);
    const poolState = await sdk.fetchPoolState(poolPk);

    // Validate mint-WSOL pair
    const tokenAMint = poolState.tokenAMint as PublicKey;
    const tokenBMint = poolState.tokenBMint as PublicKey;
    const pair = [tokenAMint.toBase58(), tokenBMint.toBase58()];
    if (!pair.includes(mintAddress.toBase58()) || !pair.includes(mints.WSOL)) {
      throw new Error('Incompatible poolAddress for DAMM v2: expected token-WSOL pair');
    }

    const tokenADecimalP = getTokenDecimals(this.connection as any, tokenAMint);
    const tokenBDecimalP = getTokenDecimals(this.connection as any, tokenBMint);
    const [tokenADecimal, tokenBDecimal] = await Promise.all([tokenADecimalP, tokenBDecimalP]);

    const inAmount = new BN(Math.round(solAmount * LAMPORTS_PER_SOL));
    const wsol = new PublicKey(mints.WSOL);
    const inputIsA = tokenAMint.equals(wsol);
    const inputTokenMint = inputIsA ? tokenAMint : tokenBMint;
    const outputTokenMint = inputIsA ? tokenBMint : tokenAMint;

    const currentSlot = await this.connection.getSlot();
    const currentTime = Math.floor(Date.now() / 1000);
    const quote = sdk.getQuote({
      inAmount,
      inputTokenMint,
      slippage: this.toPercentFromFraction(slippage),
      poolState,
      currentTime,
      currentSlot,
      tokenADecimal,
      tokenBDecimal,
    });

    const tokenAProgram = getTokenProgram(poolState.tokenAFlag);
    const tokenBProgram = getTokenProgram(poolState.tokenBFlag);

    const tx = await sdk.swap({
      payer: wallet,
      pool: poolPk,
      inputTokenMint,
      outputTokenMint,
      amountIn: inAmount,
      minimumAmountOut: quote.minSwapOutAmount,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAMint,
      tokenBMint,
      tokenAProgram,
      tokenBProgram,
      referralTokenAccount: null,
    });

    return this.stripNonEssentialInstructions(tx.instructions as TransactionInstruction[]);
  }

  async getSellInstructions(params: { mintAddress: PublicKey; wallet: PublicKey; tokenAmount: number; slippage: number; poolAddress?: PublicKey; }): Promise<TransactionInstruction[]> {
    const { mintAddress, wallet, tokenAmount, slippage, poolAddress } = params;
    const poolPk = poolAddress ?? await this.findPoolAddressForMint(mintAddress);
    const sdk = new CpAmm(this.connection);
    const poolState = await sdk.fetchPoolState(poolPk);

    const tokenAMint = poolState.tokenAMint as PublicKey;
    const tokenBMint = poolState.tokenBMint as PublicKey;
    const pair = [tokenAMint.toBase58(), tokenBMint.toBase58()];
    if (!pair.includes(mintAddress.toBase58()) || !pair.includes(mints.WSOL)) {
      throw new Error('Incompatible poolAddress for DAMM v2: expected token-WSOL pair');
    }

    const tokenADecimalP = getTokenDecimals(this.connection as any, tokenAMint);
    const tokenBDecimalP = getTokenDecimals(this.connection as any, tokenBMint);
    const [tokenADecimal, tokenBDecimal] = await Promise.all([tokenADecimalP, tokenBDecimalP]);

    const sellingIsA = tokenAMint.equals(mintAddress);
    const decimalsIn = sellingIsA ? tokenADecimal : tokenBDecimal;
    const inAmount = new BN(Math.round(tokenAmount * Math.pow(10, decimalsIn)));

    const inputTokenMint = sellingIsA ? tokenAMint : tokenBMint;
    const outputTokenMint = sellingIsA ? tokenBMint : tokenAMint; // should be WSOL side

    const currentSlot = await this.connection.getSlot();
    const currentTime = Math.floor(Date.now() / 1000);
    const quote = sdk.getQuote({
      inAmount,
      inputTokenMint,
      slippage: this.toPercentFromFraction(slippage),
      poolState,
      currentTime,
      currentSlot,
      tokenADecimal,
      tokenBDecimal,
    });

    const tokenAProgram = getTokenProgram(poolState.tokenAFlag);
    const tokenBProgram = getTokenProgram(poolState.tokenBFlag);

    const tx = await sdk.swap({
      payer: wallet,
      pool: poolPk,
      inputTokenMint,
      outputTokenMint,
      amountIn: inAmount,
      minimumAmountOut: quote.minSwapOutAmount,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAMint,
      tokenBMint,
      tokenAProgram,
      tokenBProgram,
      referralTokenAccount: null,
    });

    return this.stripNonEssentialInstructions(tx.instructions as TransactionInstruction[]);
  }
}
