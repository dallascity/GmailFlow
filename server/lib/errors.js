/** API'den istemciye dönen, çevrilebilir (i18n anahtarlı) hata. */
export class AppError extends Error {
  constructor(code, statusCode = 400, params = {}) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
    this.params = params;
  }
}
