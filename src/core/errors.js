// 统一错误类型与错误码。CLI 与 Web 共用，保证错误原因可被结构化展示。
export const ERROR_CODES = Object.freeze({
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  REQUEST_TOO_LARGE: 'REQUEST_TOO_LARGE',
  JSON_PARSE_ERROR: 'JSON_PARSE_ERROR',
  UNSUPPORTED_STRUCTURE: 'UNSUPPORTED_STRUCTURE',
  UNKNOWN_LOCKFILE_VERSION: 'UNKNOWN_LOCKFILE_VERSION',
  INVALID_RULES: 'INVALID_RULES',
});

export class AppError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    // 例如 line / column / position / limitBytes / actualBytes / lockfileVersion
    Object.assign(this, details);
  }
}

export function isAppError(err) {
  return err instanceof AppError;
}
