import { ITransactionBuilder } from '../TransactionBuilder';
import { PumpFunTransactionBuilder } from './PumpFunTransactionBuilder';
import { DBCTransactionBuilder } from './DBCTransactionBuilder';
import { LaunchpadTransactionBuilder } from './LaunchpadTransactionBuilder';
import { PumpSwapTransactionBuilder } from './PumpSwapTransactionBuilder';
import { Connection } from '@solana/web3.js';

export class TransactionBuilderRegistry {
  private static instance: TransactionBuilderRegistry;
  private builders: Map<string, ITransactionBuilder> = new Map();
  private connection: Connection;
  
  private constructor(connection: Connection) {
    this.connection = connection;
    this.registerBuilders();
  }
  
  public static getInstance(connection?: Connection): TransactionBuilderRegistry {
    if (!TransactionBuilderRegistry.instance) {
      if (!connection) {
        throw new Error('Connection is required for first initialization');
      }
      TransactionBuilderRegistry.instance = new TransactionBuilderRegistry(connection);
    }
    return TransactionBuilderRegistry.instance;
  }
  
  private registerBuilders(): void {
    // Register PumpFun builder
    const pumpFunBuilder = new PumpFunTransactionBuilder(this.connection);
    this.builders.set(pumpFunBuilder.programId, pumpFunBuilder);
    
    // Register DBC builder
    const dbcBuilder = new DBCTransactionBuilder(this.connection);
    this.builders.set(dbcBuilder.programId, dbcBuilder);
    
    // Register Launchpad builder
    const launchpadBuilder = new LaunchpadTransactionBuilder(this.connection);
    this.builders.set(launchpadBuilder.programId, launchpadBuilder);
    
    // Register PumpSwap builder
    const pumpSwapBuilder = new PumpSwapTransactionBuilder(this.connection);
    this.builders.set(pumpSwapBuilder.programId, pumpSwapBuilder);
  }
  
  public getBuilder(programId: string): ITransactionBuilder | null {
    return this.builders.get(programId) || null;
  }
  
  public hasBuilder(programId: string): boolean {
    return this.builders.has(programId);
  }
  
  public getSupportedProgramIds(): string[] {
    return Array.from(this.builders.keys());
  }
  
  public registerBuilder(builder: ITransactionBuilder): void {
    this.builders.set(builder.programId, builder);
  }
  
  public getBuilderInfo(): Array<{ programId: string; name: string }> {
    const info: Array<{ programId: string; name: string }> = [];
    
    for (const [programId, builder] of this.builders) {
      let name = 'Unknown';
      
      // Determine builder name based on programId
      switch (programId) {
        case '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P':
          name = 'PumpFun';
          break;
        case 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN':
          name = 'DBC';
          break;
        case 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj':
          name = 'Launchpad';
          break;
        case 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA':
          name = 'PumpSwap';
          break;
        // Add more cases as new builders are added
        default:
          name = `Builder_${programId.substring(0, 8)}`;
      }
      
      info.push({ programId, name });
    }
    
    return info;
  }
}

export function getTransactionBuilderRegistry(connection?: Connection): TransactionBuilderRegistry {
  return TransactionBuilderRegistry.getInstance(connection);
}