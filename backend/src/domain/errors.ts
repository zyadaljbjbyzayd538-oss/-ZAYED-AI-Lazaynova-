export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class CapabilityPermissionError extends HttpError {
  constructor() {
    super(403, 'CAPABILITY_PERMISSION_REQUIRED', 'The account is not granted this capability.');
    this.name = 'CapabilityPermissionError';
  }
}

export class CapabilityUnavailableError extends HttpError {
  constructor() {
    super(501, 'CAPABILITY_UNAVAILABLE', 'No ready execution engine is configured for this capability.');
    this.name = 'CapabilityUnavailableError';
  }
}
