import {
    assert,
    assertEquals,
    assertMatch,
    assertNotEquals,
    assertRejects,
} from '@std/assert';
import { createPool, DoublyLinkedList } from './generic-pool.ts';

// Utility function to stop pool (converted from utils.js)
async function stopPool(pool: any): Promise<void> {
    await pool.drain();
    return pool.clear();
}

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

// ===== DoublyLinkedList Tests =====

Deno.test('DoublyLinkedList - operations', () => {
    const dll = new DoublyLinkedList();

    const item1 = { id: 1 };
    const item2 = { id: 2 };
    const item3 = { id: 3 };
    const item4 = { id: 4 };

    dll.insertBeginning(DoublyLinkedList.createNode(item1));
    assertEquals(dll.head?.data, item1);

    dll.insertEnd(DoublyLinkedList.createNode(item2));
    assertEquals(dll.tail?.data, item2);

    dll.insertAfter(dll.tail!, DoublyLinkedList.createNode(item3));
    assertEquals(dll.tail?.data, item3);

    dll.insertBefore(dll.tail!, DoublyLinkedList.createNode(item4));
    assertEquals(dll.tail?.data, item3);

    dll.remove(dll.tail!);
    assertEquals(dll.tail?.data, item4);
});

// ===== Main Pool Tests =====

Deno.test('min and max limit defaults', async () => {
    const resourceFactory = new TestResourceFactory();
    const pool = createPool(resourceFactory);

    assertEquals(pool.max, 1);
    assertEquals(pool.min, 0);

    await stopPool(pool);
});

Deno.test('malformed min and max limits are ignored', async () => {
    const resourceFactory = new TestResourceFactory();
    const config = {
        min: 'asf' as any,
        max: [] as any,
    };
    const pool = createPool(resourceFactory, config);

    assertEquals(pool.max, 1);
    assertEquals(pool.min, 0);

    await stopPool(pool);
});

Deno.test('min greater than max sets to max', async () => {
    const resourceFactory = new TestResourceFactory();
    const config = {
        min: 5,
        max: 3,
    };
    const pool = createPool(resourceFactory, config);

    assertEquals(pool.max, 3);
    assertEquals(pool.min, 3);

    await stopPool(pool);
});

Deno.test('supports priority on borrow', async () => {
    let borrowTimeLow = 0;
    let borrowTimeHigh = 0;
    let borrowCount = 0;

    const resourceFactory = new TestResourceFactory();
    const config = {
        max: 1,
        priorityRange: 2,
    };

    const pool = createPool(resourceFactory, config);

    function lowPriorityOnFulfilled(obj: any) {
        const time = Date.now();
        if (time > borrowTimeLow) {
            borrowTimeLow = time;
        }
        borrowCount++;
        pool.release(obj);
    }

    function highPriorityOnFulfilled(obj: any) {
        const time = Date.now();
        if (time > borrowTimeHigh) {
            borrowTimeHigh = time;
        }
        borrowCount++;
        pool.release(obj);
    }

    const operations = [];

    for (let i = 0; i < 10; i++) {
        const op = pool.acquire(1).then(lowPriorityOnFulfilled);
        operations.push(op);
    }

    for (let i = 0; i < 10; i++) {
        const op = pool.acquire(0).then(highPriorityOnFulfilled);
        operations.push(op);
    }

    await Promise.all(operations);

    assertEquals(borrowCount, 20);
    assert(borrowTimeLow >= borrowTimeHigh);
    await stopPool(pool);
});

Deno.test('evictor removes instances on idletimeout', async () => {
    const resourceFactory = new TestResourceFactory();
    const config = {
        min: 2,
        max: 2,
        idleTimeoutMillis: 50,
        evictionRunIntervalMillis: 10,
    };
    const pool = createPool(resourceFactory, config);

    await new Promise((resolve) => setTimeout(resolve, 120));

    const res = await pool.acquire();
    assert(res.id > 1);
    await pool.release(res);
    await stopPool(pool);
});

Deno.test('tests drain', async () => {
    const count = 5;
    let acquired = 0;

    const resourceFactory = new TestResourceFactory();
    const config = {
        max: 2,
        idletimeoutMillis: 300000,
    };
    const pool = createPool(resourceFactory, config);

    const operations = [];

    function onAcquire(client: any) {
        acquired += 1;
        assertEquals(typeof client.id, 'number');
        setTimeout(() => {
            pool.release(client);
        }, 250);
    }

    // request 5 resources that release after 250ms
    for (let i = 0; i < count; i++) {
        const op = pool.acquire().then(onAcquire);
        operations.push(op);
    }

    assertNotEquals(count, acquired);

    await Promise.all(operations);
    await pool.drain();

    assertEquals(count, acquired);
    pool.clear();

    // subsequent calls to acquire should resolve an error.
    await assertRejects(
        () => pool.acquire(),
        Error,
    );
});

Deno.test('clear promise resolves with no value', async () => {
    let resources: string[] = [];
    const factory = {
        create: function create() {
            return new Promise(function tryCreate(resolve, reject) {
                let resource = resources.shift();
                if (resource) {
                    resolve(resource);
                } else {
                    setTimeout(() => tryCreate(resolve, reject), 0);
                }
            });
        },
        destroy: function () {
            return Promise.resolve();
        },
    };
    const pool = createPool(factory, { max: 3, min: 3 });

    Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]).then(
        (all) => {
            all.forEach((resource) => {
                setTimeout(() => pool.release(resource), 0);
            });
        },
    );

    assertEquals(pool.pending, 3, 'all acquisitions pending');

    setTimeout(() => {
        resources.push('a');
        resources.push('b');
        resources.push('c');
    }, 0);

    await pool.drain();
    const resolved = await pool.clear();
    assertEquals(resolved, undefined, 'clear promise resolves with no value');
});

Deno.test('handle creation errors', async () => {
    let created = 0;
    const resourceFactory = {
        create: function () {
            created++;
            if (created < 5) {
                return Promise.reject(new Error('Error occurred.'));
            } else {
                return Promise.resolve({ id: created });
            }
        },
        destroy: async function (client: any) {},
    };
    const config = {
        max: 1,
    };

    const pool = createPool(resourceFactory, config);

    let called = false;
    const client = await pool.acquire();
    assertEquals(typeof client.id, 'number');
    called = true;
    pool.release(client);

    assert(called);
    assertEquals(pool.pending, 0);
    await stopPool(pool);
});

Deno.test('handle creation errors for delayed creates', async () => {
    let attempts = 0;

    const resourceFactory = {
        create: function () {
            attempts++;
            if (attempts <= 5) {
                return Promise.reject(new Error('Error occurred.'));
            } else {
                return Promise.resolve({ id: attempts });
            }
        },
        destroy: function (client: any) {
            return Promise.resolve();
        },
    };

    const config = {
        max: 1,
    };

    const pool = createPool(resourceFactory, config);

    let errorCount = 0;
    pool.on('factoryCreateError', function (err: Error) {
        assert(err instanceof Error);
        errorCount++;
    });

    let called = false;
    const client = await pool.acquire();
    assertEquals(typeof client.id, 'number');
    called = true;
    pool.release(client);

    assert(called);
    assertEquals(errorCount, 5);
    assertEquals(pool.pending, 0);
    await stopPool(pool);
});

Deno.test('getPoolSize', async () => {
    let assertionCount = 0;
    const resourceFactory = new TestResourceFactory();
    const config = {
        max: 2,
    };

    const pool = createPool(resourceFactory, config);
    const borrowedResources: any[] = [];

    assertEquals(pool.size, 0);
    assertionCount += 1;

    const obj1 = await pool.acquire();
    borrowedResources.push(obj1);
    assertEquals(pool.size, 1);
    assertionCount += 1;

    const obj2 = await pool.acquire();
    borrowedResources.push(obj2);
    assertEquals(pool.size, 2);
    assertionCount += 1;

    pool.release(borrowedResources.shift());
    pool.release(borrowedResources.shift());

    const obj3 = await pool.acquire();
    // should still be 2
    assertEquals(pool.size, 2);
    assertionCount += 1;
    pool.release(obj3);

    assertEquals(assertionCount, 4);
    await stopPool(pool);
});

Deno.test('availableObjectsCount', async () => {
    let assertionCount = 0;
    const resourceFactory = new TestResourceFactory();
    const config = {
        max: 2,
    };

    const pool = createPool(resourceFactory, config);
    const borrowedResources: any[] = [];

    assertEquals(pool.available, 0);
    assertionCount += 1;

    const obj1 = await pool.acquire();
    borrowedResources.push(obj1);
    assertEquals(pool.available, 0);
    assertionCount += 1;

    const obj2 = await pool.acquire();
    borrowedResources.push(obj2);
    assertEquals(pool.available, 0);
    assertionCount += 1;

    pool.release(borrowedResources.shift());
    assertEquals(pool.available, 1);
    assertionCount += 1;

    pool.release(borrowedResources.shift());
    assertEquals(pool.available, 2);
    assertionCount += 1;

    const obj3 = await pool.acquire();
    assertEquals(pool.available, 1);
    assertionCount += 1;
    pool.release(obj3);

    assertEquals(pool.available, 2);
    assertionCount += 1;

    assertEquals(assertionCount, 7);
    await stopPool(pool);
});

Deno.test('do schedule again if error occurred when creating new Objects async', async () => {
    // NOTE: we're simulating the first few resource attempts failing
    let resourceCreationAttempts = 0;

    const factory = {
        create: function () {
            resourceCreationAttempts++;
            if (resourceCreationAttempts < 2) {
                return Promise.reject(new Error('Create Error'));
            }
            return Promise.resolve({});
        },
        destroy: async function (client: any) {},
    };

    const config = {
        max: 1,
    };

    const pool = createPool(factory, config);

    const obj = await pool.acquire();
    assertEquals(pool.available, 0);
    pool.release(obj);
    await stopPool(pool);
});

Deno.test('returns only valid object to the pool', async () => {
    const pool = createPool(new TestResourceFactory(), { max: 1 });

    const obj = await pool.acquire();
    assertEquals(pool.available, 0);
    assertEquals(pool.borrowed, 1);

    // Invalid release
    await assertRejects(
        () => pool.release({}),
        Error,
        'Resource not currently part of this pool',
    );

    assertEquals(pool.available, 0);
    assertEquals(pool.borrowed, 1);

    // Valid release
    await pool.release(obj);
    assertEquals(pool.available, 1);
    assertEquals(pool.borrowed, 0);
    await stopPool(pool);
});

Deno.test('validate acquires object from the pool', async () => {
    const pool = createPool(new TestResourceFactory(), { max: 1 });

    const obj = await pool.acquire();
    assertEquals(pool.available, 0);
    assertEquals(pool.borrowed, 1);
    pool.release(obj);
    await stopPool(pool);
});

Deno.test('release to pool should work', async () => {
    const pool = createPool(new TestResourceFactory(), { max: 1 });

    const obj1 = await pool.acquire();
    assertEquals(pool.available, 0);
    assertEquals(pool.borrowed, 1);
    assertEquals(pool.pending, 0);

    const obj2Promise = pool.acquire();
    assertEquals(pool.pending, 1);

    await pool.release(obj1);
    const obj2 = await obj2Promise;

    assertEquals(pool.available, 0);
    assertEquals(pool.borrowed, 1);
    assertEquals(pool.pending, 0);

    await pool.release(obj2);
    await stopPool(pool);
});

Deno.test('isBorrowedResource should return true for borrowed resource', async () => {
    const pool = createPool(new TestResourceFactory(), { max: 1 });

    const obj = await pool.acquire();
    assertEquals(pool.isBorrowedResource(obj), true);
    await pool.release(obj);
    await stopPool(pool);
});

Deno.test('isBorrowedResource should return false for released resource', async () => {
    const pool = createPool(new TestResourceFactory(), { max: 1 });

    const obj = await pool.acquire();
    await pool.release(obj);
    assertEquals(pool.isBorrowedResource(obj), false);
    await stopPool(pool);
});

Deno.test('destroy should redispense', async () => {
    const pool = createPool(new TestResourceFactory(), { max: 1 });

    const obj1 = await pool.acquire();
    assertEquals(pool.available, 0);
    assertEquals(pool.borrowed, 1);

    const obj2Promise = pool.acquire();
    assertEquals(pool.pending, 1);

    pool.destroy(obj1);

    const obj2 = await obj2Promise;
    assertEquals(pool.available, 0);
    assertEquals(pool.borrowed, 1);
    assertEquals(pool.pending, 0);

    await pool.release(obj2);
    await stopPool(pool);
});

Deno.test('evictor start with acquire when autostart is false', async () => {
    const pool = createPool(new TestResourceFactory(), {
        evictionRunIntervalMillis: 10000,
        autostart: false,
    });

    assertEquals((pool as any)._scheduledEviction, null);

    const obj = await pool.acquire();
    assertNotEquals((pool as any)._scheduledEviction, null);
    await pool.release(obj);
    await stopPool(pool);
});

Deno.test('use method', async () => {
    const pool = createPool(new TestResourceFactory());

    await pool.use((resource: any) => {
        assertEquals(resource.id, 0);
        return Promise.resolve();
    });
});

Deno.test('use method should resolve after fn promise is resolved', async () => {
    const pool = createPool(new TestResourceFactory());
    let doneWithResource = false;

    const result = await pool.use((resource: any) => {
        return new Promise((resolve) => {
            setTimeout(() => {
                doneWithResource = true;
                resolve('value');
            }, 0);
        });
    });

    assertEquals(doneWithResource, true);
    assertEquals(result, 'value');
});

Deno.test('evictor should not run when softIdleTimeoutMillis is -1', async () => {
    const resourceFactory = new TestResourceFactory();
    const pool = createPool(resourceFactory, {
        evictionRunIntervalMillis: 10,
    });

    const res = await pool.acquire();
    await pool.release(res);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEquals(resourceFactory.destroyed, 0);
    await stopPool(pool);
});

Deno.test('should respect when maxWaitingClients is set to 0', async () => {
    let assertionCount = 0;
    const resourceFactory = new TestResourceFactory();
    const config = {
        max: 2,
        maxWaitingClients: 0,
    };

    const pool = createPool(resourceFactory, config);
    const borrowedResources: any[] = [];

    assertEquals(pool.size, 0);
    assertionCount += 1;

    const obj1 = await pool.acquire();
    borrowedResources.push(obj1);
    assertEquals(pool.size, 1);
    assertionCount += 1;

    const obj2 = await pool.acquire();
    borrowedResources.push(obj2);
    assertEquals(pool.size, 2);
    assertionCount += 1;

    await assertRejects(
        () => pool.acquire(),
        Error,
        'max waitingClients count exceeded',
    );
});

Deno.test('should provide a way to wait until the pool is ready', async () => {
    const resourceFactory = new TestResourceFactory();
    const config = {
        min: 2,
        max: 4,
    };

    const pool = createPool(resourceFactory, config);

    await pool.ready();
    assert(
        pool.available >= config.min,
        'expected available resources to be at least as the minimum',
    );
});

// ===== Timeout Tests =====

Deno.test('destroyTimeout handles timed out destroy calls', async () => {
    let rogueTimeout: ReturnType<typeof setTimeout> | undefined;
    const factory = {
        create: function () {
            return Promise.resolve({});
        },
        destroy: function () {
            return new Promise<void>(function (resolve) {
                rogueTimeout = setTimeout(function () {
                    resolve();
                }, 100);
            });
        },
    };
    const config = {
        destroyTimeoutMillis: 20,
    };

    const pool = createPool(factory, config);

    const resource = await pool.acquire();
    pool.destroy(resource);
    await new Promise(function (resolve) {
        pool.on('factoryDestroyError', function (err: Error) {
            assertMatch(err.message, /destroy timed out/);
            resolve(undefined);
        });
    });

    clearTimeout(rogueTimeout);
});

Deno.test('destroyTimeout handles non timed out destroy calls', async () => {
    const factory = {
        create: function () {
            return Promise.resolve({});
        },
        destroy: function () {
            return new Promise<void>(function (resolve) {
                setTimeout(function () {
                    resolve();
                }, 10);
            });
        },
    };

    const config = {
        destroyTimeoutMillis: 400,
    };

    const pool = createPool(factory, config);

    const resource = await pool.acquire();

    pool.destroy(resource);
    await new Promise(function (resolve) {
        pool.on('factoryDestroyError', function (err: Error) {
            throw new Error('Should not have timed out');
        });
        setTimeout(resolve, 20);
    });
});

Deno.test('acquireTimeout handles timed out acquire calls', async () => {
    const factory = {
        create: function () {
            return new Promise(function (resolve) {
                setTimeout(function () {
                    resolve({});
                }, 100);
            });
        },
        destroy: function () {
            return Promise.resolve();
        },
    };
    const config = {
        acquireTimeoutMillis: 20,
        idleTimeoutMillis: 150,
        log: false,
    };

    const pool = createPool(factory, config);

    await assertRejects(
        () => pool.acquire(),
        Error,
        'ResourceRequest timed out',
    );

    await pool.drain();
    await pool.clear();
});

Deno.test('acquireTimeout handles non timed out acquire calls', async () => {
    const myResource = {};
    const factory = {
        create: function () {
            return new Promise(function (resolve) {
                setTimeout(function () {
                    resolve(myResource);
                }, 10);
            });
        },
        destroy: function () {
            return Promise.resolve();
        },
    };

    const config = {
        acquireTimeoutMillis: 400,
    };

    const pool = createPool(factory, config);

    const resource = await pool.acquire();
    assertEquals(resource, myResource);
    pool.release(resource);
    await pool.drain();
    await pool.clear();
});

// ===== GitHub Issue #159 Test =====

class ResourceFactoryDelayCreateEachSecond {
    callCreate = 0;
    created = 0;
    destroyed = 0;
    bin: any[] = [];

    create(): Promise<{ id: number }> {
        const that = this;
        console.log(`** create call ${that.callCreate}`);
        return new Promise((resolve) => {
            if (that.callCreate % 2 === 0) {
                setTimeout(function () {
                    console.log(`** created ${that.created}`);
                    resolve({ id: that.created++ });
                }, 10);
            } else {
                console.log(`** created ${that.created}`);
                resolve({ id: that.created++ });
            }
            that.callCreate++;
        });
    }

    validate(): Promise<boolean> {
        return Promise.resolve(true);
    }

    destroy(resource: any): Promise<void> {
        console.log(`** destroying ${resource.id}`);
        this.destroyed++;
        this.bin.push(resource);
        return Promise.resolve();
    }
}

Deno.test('tests drain clear with autostart and min > 0', async () => {
    const resourceFactory = new ResourceFactoryDelayCreateEachSecond();
    const config = {
        max: 10,
        min: 1,
        evictionRunIntervalMillis: 500,
        idleTimeoutMillis: 30000,
        testOnBorrow: true,
        autostart: true,
    };
    const pool = createPool(resourceFactory, config);

    console.log('** pool drained');
    await pool.drain();

    console.log('** pool cleared');
    await pool.clear();

    assertEquals(resourceFactory.created, resourceFactory.destroyed);
});
