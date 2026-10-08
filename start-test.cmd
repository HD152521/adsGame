@echo off
REM Local feature test: no payment, ads are added instantly (FREE_MODE), logos auto-approved.
REM Admin page: http://127.0.0.1:5173/admin.html  token: local-admin-token-1234
cd /d "%~dp0"
set ADMIN_TOKEN=local-admin-token-1234
set WEBHOOK_SECRET=local-webhook-secret-1234
set FREE_MODE=1
set MODERATION_MODE=auto-approve
node server\index.js
pause
