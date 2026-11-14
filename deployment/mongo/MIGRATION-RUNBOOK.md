# Six Star POS — Atlas to MongoDB Community Migration Runbook

## 1. Architecture and safety

The VPS hosts one MongoDB Community 8.0 installation using a single-node replica set named rs0.

Separate databases:
- Staging: sixstar_staging
- Production: existing production database

Separate application users:
- sixstar_staging_app
- sixstar_app

The staging and production applications must use separate database credentials and connection strings.

IMPORTANT:
- ATLAS_URI remains the existing PRODUCTION Atlas connection string.
- STAGING_ATLAS_URI is the existing STAGING Atlas connection string.
- Never replace production ATLAS_URI with the staging connection string.
- Never point staging at the production Community database.
- Keep Atlas available as the rollback source.
- Do not perform production cutover until staging passes all tests and explicit approval is given.

## 2. Pre-installation checks

Confirm:
- VPS backup and recovery access are available.
- Cloudflare R2 private bucket sixstar-pos-backups exists.
- R2 credentials have the required object read/write permissions.
- VPS IP is allowed in both Atlas projects.
- Both Atlas deployments are accessible.
- Sufficient VPS memory and disk space are available.
- Production API and worker status have been checked.
- The MongoDB installer has been reviewed.

## 3. Install MongoDB Community

Only after explicitly approving installation:

    cd /var/www/sixstar-pos/deployment/mongo
    sudo bash install-mongodb.sh --db <production-db-name> --alert-email <your-email>

After installation:

    sudo sixstar-mongoctl status
    sudo sixstar-mongoctl txn-test

The transaction test must pass.

Securely copy /etc/sixstar/age-identity.txt off the VPS. This private key is required to decrypt encrypted backups.

Configure:

    sudo nano /etc/sixstar/mongo-ops.env
    sudo nano /etc/sixstar/migration.env

The migration environment must preserve both Atlas sources:

    ATLAS_URI=<existing-production-atlas-uri>
    STAGING_ATLAS_URI=<existing-staging-atlas-uri>

Optional database overrides:

    ATLAS_DB=<production-database-name>
    STAGING_ATLAS_DB=<staging-database-name>

Never commit credentials or paste them into chat.

## 4. Verify backups

Configure R2 and verify backup operations before migrating either database:

    sudo sixstar-mongoctl backup full --manual
    sudo sixstar-mongoctl verify latest

Stop if backup verification fails.

## 5. Migrate staging first

Configure STAGING_MONGODB_URI for the Community staging destination.

Run the staging-only migration:

    sudo sixstar-mongoctl migrate audit --target staging
    sudo sixstar-mongoctl migrate backup --target staging
    sudo sixstar-mongoctl migrate stage
    sudo sixstar-mongoctl migrate reconcile --target staging

This phase must migrate only staging data.

Do not modify production application environment files.

## 6. Configure and test staging

Set staging MONGODB_URI to the generated staging application connection string.

Staging must use:

- NODE_ENV=staging
- A unique JWT_SECRET
- A unique JWT_REFRESH_SECRET
- MPESA_ENVIRONMENT=sandbox
- ETIMS_ENVIRONMENT=sandbox
- No production SMS or PayHero credentials

Deploy staging using the staging deployment procedure.

Test:
- Health and database connectivity
- Login and authentication
- Product creation and updates
- Sales and receipts
- Inventory and stock movements
- Purchases and suppliers
- Reports and dashboard totals
- Refunds
- Audit log
- M-Pesa sandbox flows
- eTIMS sandbox flows
- Worker and scheduled-job behavior
- Restart and data persistence
- Backup and restore

Do not proceed until staging passes.

## 7. Prepare production after staging passes

Keep production ATLAS_URI unchanged.

Run:

    sudo sixstar-mongoctl migrate audit --target prod
    sudo sixstar-mongoctl migrate backup --target prod
    sudo sixstar-mongoctl migrate reconcile --target prod

These are production preflight operations. They do not switch production traffic.

## 8. Production cutover — explicit approval required

Before cutover verify:

- Staging has passed all tests.
- Production audit and backup succeeded.
- Production reconciliation succeeded.
- MongoDB transaction test passes.
- R2 backup verification passes.
- Production environment files are backed up.
- Production API is healthy.
- Maintenance window and rollback plan are ready.

Only after explicit approval, during the maintenance window:

    sudo sixstar-mongoctl migrate cutover --confirm CUTOVER

The migration tool is expected to:
1. Recheck migration prerequisites.
2. Refuse unsafe destination states.
3. Enable maintenance.
4. Stop the worker safely.
5. Create a fresh encrypted Atlas backup.
6. Copy production Atlas data to Community.
7. Perform reconciliation.
8. Update production MONGODB_URI settings.
9. Restart and verify API services.
10. Verify database health.
11. Restart the worker.
12. Disable maintenance.

If anything fails, inspect migration logs and follow the tool's rollback procedure. Never manually delete Atlas data.

After cutover test:
- Login
- Sales and receipts
- Inventory
- Reports
- M-Pesa live callbacks
- SMS
- Worker and scheduled jobs
- Backups and restore verification

## 9. Rollback

Only after reviewing the situation and explicitly approving rollback:

    sudo sixstar-mongoctl migrate rollback --confirm ROLLBACK

Optional rollback without synchronizing Community changes back to Atlas:

    sudo sixstar-mongoctl migrate rollback --confirm ROLLBACK --no-sync-back

Use the no-sync option only when accepting that Community-side changes will not be copied back.

Inspect rollback reports and verify production health afterward.

## 10. Finalization

Keep Atlas available throughout the rollback observation period.

After at least 14 days and a successful restore test:

    sudo sixstar-mongoctl restore-test
    sudo sixstar-mongoctl migrate finalize

The migration tool does not delete the Atlas deployment. Manage Atlas retirement separately.

## 11. Daily operations

Monitor:
- MongoDB health
- Memory and swap
- Disk capacity
- Backup completion and verification
- Oplog archiving
- Retention cleanup
- Restore tests
- API and worker memory
- Query performance

Backup configuration:

    /etc/sixstar/backup.json

Dashboard:

    Admin > Infrastructure > MongoDB health

## 12. Recovery

Inspect recovery points:

    sudo sixstar-mongoctl recovery

Create a separate recovery instance:

    sudo sixstar-mongoctl restore recover latest

Never promote a recovery database over production without explicit approval and a verified safety backup.

## 13. Important limitations

- A single VPS MongoDB replica set is not high availability.
- Staging and production must use separate databases and application users.
- Production ATLAS_URI remains unchanged during staging migration.
- Delta synchronization does not automatically propagate hard deletes.
- Reconciliation must pass before production cutover.
- No migration is successful until source, destination, backup, and application tests pass.
- Installation, staging migration, production preparation, cutover, rollback, and finalization are separate operations.
