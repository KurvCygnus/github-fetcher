export interface VerifyOptions {
  root?: string;
  offline?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

export function verifyLaunch(options?: VerifyOptions): Promise<VerifyResult>;
