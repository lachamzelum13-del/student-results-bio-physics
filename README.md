# Student Results Website - Biology + Physics

This version uses exactly these upload columns:

`admission_no, name, class, biology_marks, biology_status, physics_marks, physics_status`

It is compatible with the existing Render + Supabase setup. On startup, `server.js` safely adds the new columns to the existing `students` table with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

## Student result
Search by admission number. The page shows admission number, name, class, Biology marks/result, and Physics marks/result.

## Admin
Visit `/admin` and upload `.xlsx`, `.xls`, or `.csv` files using the columns above.

## Render
Keep the same environment variables:
- `DATABASE_URL`
- `ADMIN_USER`
- `ADMIN_PASS`
- `SESSION_SECRET`

Build command: `npm install`
Start command: `npm start`
