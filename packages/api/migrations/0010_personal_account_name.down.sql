-- Reconstruct the old "Personal <full wallet>" name from login_wallet.
UPDATE accounts
SET name = 'Personal ' || login_wallet
WHERE privy_user_id IS NULL
  AND name = 'Personal';
