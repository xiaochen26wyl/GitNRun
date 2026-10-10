/** 訊息可以直接顯示給使用者看的錯誤；不得夾帶金鑰、請求細節或內部路徑。 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}
