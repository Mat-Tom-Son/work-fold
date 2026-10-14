export interface InputContract {
  variants: Array<{ when?: Record<string, string>; required?: string[] }>;
  examples: Array<Record<string, unknown>>;
}
export function withInputContract<T extends { name: string; description: string; parameters: unknown }>(tool: T, contract: InputContract): T;
export function withToolContracts<T extends { registerTool: (...args: any[]) => unknown }>(pi: T, contracts: Record<string, InputContract>): T;
