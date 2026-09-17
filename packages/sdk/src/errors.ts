export class JevyrHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "JevyrHttpError";
  }
}

export class JevyrContinuityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevyrContinuityError";
  }
}
