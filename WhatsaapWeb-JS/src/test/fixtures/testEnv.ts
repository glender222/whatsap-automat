if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters-for-testing';
}
if (!process.env.DB_PASSWORD) {
  process.env.DB_PASSWORD = 'test-only-database-password';
}
if (!process.env.META_TOKEN_ENCRYPTION_KEY) {
  process.env.META_TOKEN_ENCRYPTION_KEY = '12345678901234567890123456789012';
}
