export type ConvoyErrorCode =
  | 'conflict'
  | 'forbidden'
  | 'invalid_input'
  | 'not_found'
  | 'not_ready'
  | 'uncertain_outcome';
export type ErrorEnvelope = {
  error: {
    code: ConvoyErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
};
