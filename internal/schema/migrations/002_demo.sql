-- Demo data for a test environment only. No functional organizer credentials are created.
INSERT INTO users(id,email,password_hash,role)
VALUES('10000000-0000-4000-8000-000000000001','demo-organizer@invalid.example','DISABLED','organizer')
ON CONFLICT DO NOTHING;
INSERT INTO venues(id,name,city)
VALUES('20000000-0000-4000-8000-000000000001','TozaiTech Demo Hall','Tokyo')
ON CONFLICT DO NOTHING;
INSERT INTO events(id,venue_id,organizer_id,title,starts_at,status)
VALUES('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
'10000000-0000-4000-8000-000000000001','TozaiTech Demo Concert',now()+interval '30 days','published')
ON CONFLICT DO NOTHING;
INSERT INTO seats(id,venue_id,section,row_label,seat_number)
SELECT ('40000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
'20000000-0000-4000-8000-000000000001','Main','A',i
FROM generate_series(1,12) i ON CONFLICT DO NOTHING;
INSERT INTO event_seats(event_id,seat_id,price_yen)
SELECT '30000000-0000-4000-8000-000000000001',
 ('40000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,3000
FROM generate_series(1,12) i ON CONFLICT DO NOTHING;
