-- 003_admin.sql: Seed admin user for ETicket Admin Panel
CREATE EXTENSION IF NOT EXISTS pgcrypto;
INSERT INTO users(id, email, password_hash, role)
VALUES(
    '00000000-0000-4000-8000-000000000001',
    'admin@tozaitech.com',
    crypt('AdminPass1234!', gen_salt('bf', 10)),
    'admin'
) ON CONFLICT (email) DO UPDATE SET role = 'admin', password_hash = EXCLUDED.password_hash;

-- Ensure up to 24 seats exist for demo venue
INSERT INTO seats(id,venue_id,section,row_label,seat_number)
SELECT ('40000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
'20000000-0000-4000-8000-000000000001','Main','A',i
FROM generate_series(1,24) i ON CONFLICT DO NOTHING;
