/** 统一的业务错误，携带 HTTP 状态码与机器可读错误码 */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const err = {
  badRequest: (msg) => new ApiError(400, 'BAD_REQUEST', msg),
  unauthorized: (msg = '凭据缺失或无效') => new ApiError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg) => new ApiError(403, 'FORBIDDEN', msg),
  notFound: (msg) => new ApiError(404, 'NOT_FOUND', msg),
  conflict: (msg) => new ApiError(409, 'CONFLICT', msg),
};
