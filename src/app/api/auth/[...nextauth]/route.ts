import { handlers } from '../../../../lib/auth/config';

// The Drizzle adapter and `pg` require the Node.js runtime.
export const runtime = 'nodejs';

export const { GET, POST } = handlers;
