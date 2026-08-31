INSERT INTO clients VALUES (21, NULL);
INSERT INTO payroll_batches VALUES (31, 999);
INSERT INTO timesheets VALUES (81, 999, 10, 1, 8, 'approved', 8, NULL, NULL, 'included', NULL, 'included', NULL);
INSERT INTO timesheets VALUES (82, 60, 10, 1, 8, 'approved', 8, NULL, NULL, 'unpaid', NULL, 'uninvoiced', 70);
UPDATE timesheets SET "approvedMinutes" = NULL WHERE id = 80;
