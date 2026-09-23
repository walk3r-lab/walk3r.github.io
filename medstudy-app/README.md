# MedStudy Space

Production full-stack anatomy learning platform.

## Stack
- Node.js + Express
- Supabase PostgreSQL
- bcrypt password hashing
- HttpOnly JWT session cookie
- YouTube lecture resources
- Manual M-Pesa payment-code verification

## Deploy
Set the service root directory to `medstudy-app`, build command `npm install`, start command `npm start`.

Environment variables:
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
JWT_SECRET
ADMIN_EMAIL
ADMIN_PASSWORD
SUBSCRIPTION_PRICE=600
PAYMENT_NUMBER=0736501740
NODE_ENV=production

Run `sql/schema.sql` once in Supabase SQL Editor before starting the service.

The developer account is created automatically from ADMIN_EMAIL and ADMIN_PASSWORD. Never commit secrets.
