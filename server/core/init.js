import { initDiningSchema } from '../../dining-server.js';
import { storeContext, STORES } from './config.js';
import { db, initSchema } from './db.js';
import { seedTables } from '../tables/seed.js';
import { seedMenu } from '../menu/seed.js';
import { seedInventory } from '../inventory/seed.js';
import { seedStaff } from '../staff/seed.js';

for (const store of Object.keys(STORES)) storeContext.run(store, () => { initSchema(); seedMenu(); seedInventory(); seedTables(); seedStaff(); initDiningSchema(db); });
