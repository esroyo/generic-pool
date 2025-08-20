import { createPool } from './generic-pool.ts';

// Basic ResourceFactory for testing (converted from utils.js)
class TestResourceFactory {
    created = 0;
    destroyed = 0;
    bin: any[] = [];

    create(): Promise<{ id: number }> {
        return Promise.resolve({ id: this.created++ });
    }

    validate(): Promise<boolean> {
        return Promise.resolve(true);
    }

    destroy(resource: any): Promise<void> {
        this.destroyed++;
        this.bin.push(resource);
        return Promise.resolve();
    }
}

const resourceFactory = new TestResourceFactory();
const pool = createPool(resourceFactory, {
    max: Number.MAX_SAFE_INTEGER,
    autostart: false,
    evictionRunIntervalMillis: 1_000,
    min: 0,
});

Deno.bench('acquire and release', async () => {
    const resource = await pool.acquire();
    await pool.release(resource);
});
