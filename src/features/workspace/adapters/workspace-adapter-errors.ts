export class WorkspaceAdapterValidationError extends Error {
  constructor(readonly field: string) {
    super(`invalid workspace adapter field: ${field}`);
    this.name = 'WorkspaceAdapterValidationError';
  }
}

export class WorkspaceAdapterLimitError extends Error {
  constructor(
    readonly field: string,
    readonly limit: number,
    readonly actual: number,
  ) {
    super(`workspace adapter limit exceeded for ${field}: ${actual} > ${limit}`);
    this.name = 'WorkspaceAdapterLimitError';
  }
}
