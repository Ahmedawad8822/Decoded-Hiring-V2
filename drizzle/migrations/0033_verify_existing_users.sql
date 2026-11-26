-- Email verification becomes required for sign-in. Every account that exists
-- before this ships keeps access: mark them verified once.
UPDATE `user` SET `email_verified` = 1 WHERE `email_verified` = 0;
