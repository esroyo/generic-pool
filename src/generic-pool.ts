// Minimal EventEmitter replacement - only implements what's actually used
type Listener = (...args: any[]) => void;

type ListenerMetadata = {
    wrapped: EventListener;
    cleanupToken: object;
};

class EventEmitter extends EventTarget {
    protected _listenerMetadata = new WeakMap<Listener, ListenerMetadata>();
    protected _finalizationRegistry = new FinalizationRegistry(
        (cleanup: () => void) => {
            cleanup();
        },
    );

    emit(type: string, ...args: any[]): boolean {
        const event = new CustomEvent(type, { detail: args });
        return this.dispatchEvent(event);
    }

    on(type: string, listener: Listener): void {
        const listenerRef = new WeakRef(listener);
        const wrapped = (event: Event) => {
            const custom = event as CustomEvent<any[]>;
            listenerRef.deref()?.(...custom.detail);
        };

        // Create metadata object with cleanup token
        const cleanupToken = {};
        const metadata: ListenerMetadata = { wrapped, cleanupToken };

        this._listenerMetadata.set(listener, metadata);
        this.addEventListener(type, wrapped);

        // Register cleanup for when the listener function is garbage collected
        this._finalizationRegistry.register(listener, () => {
            this.removeEventListener(type, wrapped);
        }, cleanupToken);
    }

    off(
        type: string,
        listener: Listener,
        options?: boolean | EventListenerOptions,
    ): void {
        const metadata = this._listenerMetadata.get(listener);

        if (metadata) {
            const { wrapped, cleanupToken } = metadata;

            this.removeEventListener(type, wrapped, options);
            this._listenerMetadata.delete(listener);

            // Properly unregister from finalization registry
            this._finalizationRegistry.unregister(cleanupToken);
        }
    }

    once(type: string, listener: Listener): void {
        const cleanupToken = {};

        const listenerRef = new WeakRef(listener);
        const wrapped = (event: Event) => {
            const custom = event as CustomEvent<any[]>;
            listenerRef.deref()?.(...custom.detail);

            // Clean up our tracking when the event fires
            this._listenerMetadata.delete(listener);
            this._finalizationRegistry.unregister(cleanupToken);
        };

        // Create metadata object
        const metadata: ListenerMetadata = { wrapped, cleanupToken };
        this._listenerMetadata.set(listener, metadata);
        this.addEventListener(type, wrapped, { once: true });

        // Register cleanup for abandoned once listeners that never fire
        this._finalizationRegistry.register(listener, () => {
            this.removeEventListener(type, wrapped);
        }, cleanupToken);
    }
}

// Factory Validator
function validateFactory<T>(factory: Factory<T>): void {
    if (typeof factory.create !== 'function') {
        throw new TypeError('factory.create must be a function');
    }
    if (typeof factory.destroy !== 'function') {
        throw new TypeError('factory.destroy must be a function');
    }
    if (
        typeof factory.validate !== 'undefined' &&
        typeof factory.validate !== 'function'
    ) {
        throw new TypeError('factory.validate must be a function');
    }
}

// Interfaces

/**
 * Factory interface for creating, destroying, and optionally validating resources.
 * @template T The type of resource this factory creates
 */
export interface Factory<T> {
    /**
     * Creates a new resource. Should return a Promise that resolves to the resource
     * or rejects with an Error if unable to create.
     * @returns Promise that resolves to a resource
     */
    create(): Promise<T>;

    /**
     * Destroys a resource. Should return a Promise that resolves once the resource
     * has been destroyed.
     * @param client The resource to destroy
     * @returns Promise that resolves when destruction is complete
     */
    destroy(client: T): Promise<void>;

    /**
     * Optional validation function for resources. Should return a Promise that resolves
     * to true if the resource is valid, false otherwise.
     * @param client The resource to validate
     * @returns Promise that resolves to validation result
     */
    validate?(client: T): Promise<boolean>;
}

/**
 * Configuration options for the pool.
 */
export interface Options {
    /** Maximum number of resources to create at any given time (default: 1) */
    max?: number;

    /** Minimum number of resources to keep in pool at any given time (default: 0) */
    min?: number;

    /** Maximum number of queued requests allowed */
    maxWaitingClients?: number;

    /** Should the pool validate resources before giving them to clients */
    testOnBorrow?: boolean;

    /** Should the pool validate resources when they are returned */
    testOnReturn?: boolean;

    /** Max milliseconds an acquire call will wait before timing out */
    acquireTimeoutMillis?: number;

    /** Max milliseconds a destroy call will wait before timing out */
    destroyTimeoutMillis?: number;

    /** If true, oldest resources are allocated first (FIFO). If false, most recent (LIFO) (default: true) */
    fifo?: boolean;

    /** Priority range for queuing (default: 1) */
    priorityRange?: number;

    /** Should the pool start creating resources immediately (default: true) */
    autostart?: boolean;

    /** How often to run eviction checks in milliseconds (default: 0 - disabled) */
    evictionRunIntervalMillis?: number;

    /** Number of resources to check each eviction run (default: 3) */
    numTestsPerEvictionRun?: number;

    /** Time an object may sit idle before eligible for eviction with min idle condition (default: -1 - disabled) */
    softIdleTimeoutMillis?: number;

    /** Minimum time an object may sit idle before eligible for eviction (default: 30000) */
    idleTimeoutMillis?: number;

    /** Promise implementation to use (default: global Promise) */
    Promise?: PromiseConstructor;
}

interface EvictionConfig {
    softIdleTimeoutMillis: number;
    idleTimeoutMillis: number;
    min: number;
}

// Pool Defaults
class PoolDefaults {
    fifo: boolean = true;
    priorityRange: number = 1;
    testOnBorrow: boolean = false;
    testOnReturn: boolean = false;
    autostart: boolean = true;
    evictionRunIntervalMillis: number = 0;
    numTestsPerEvictionRun: number = 3;
    softIdleTimeoutMillis: number = -1;
    idleTimeoutMillis: number = 30000;
    acquireTimeoutMillis: number | null = null;
    destroyTimeoutMillis: number | null = null;
    maxWaitingClients: number | null = null;
    min: number | null = null;
    max: number | null = null;
    Promise: PromiseConstructor = Promise;
}

// Pool Options
class PoolOptions {
    fifo: boolean;
    priorityRange: number;
    testOnBorrow: boolean;
    testOnReturn: boolean;
    autostart: boolean;
    acquireTimeoutMillis?: number;
    destroyTimeoutMillis?: number;
    maxWaitingClients?: number;
    max: number;
    min: number;
    evictionRunIntervalMillis: number;
    numTestsPerEvictionRun: number;
    softIdleTimeoutMillis: number;
    idleTimeoutMillis: number;
    Promise: PromiseConstructor;

    constructor(opts: Options = {}) {
        const poolDefaults = new PoolDefaults();

        this.fifo = typeof opts.fifo === 'boolean'
            ? opts.fifo
            : poolDefaults.fifo;
        this.priorityRange = opts.priorityRange || poolDefaults.priorityRange;
        this.testOnBorrow = typeof opts.testOnBorrow === 'boolean'
            ? opts.testOnBorrow
            : poolDefaults.testOnBorrow;
        this.testOnReturn = typeof opts.testOnReturn === 'boolean'
            ? opts.testOnReturn
            : poolDefaults.testOnReturn;
        this.autostart = typeof opts.autostart === 'boolean'
            ? opts.autostart
            : poolDefaults.autostart;

        if (opts.acquireTimeoutMillis) {
            this.acquireTimeoutMillis = parseInt(
                opts.acquireTimeoutMillis.toString(),
                10,
            );
        }
        if (opts.destroyTimeoutMillis) {
            this.destroyTimeoutMillis = parseInt(
                opts.destroyTimeoutMillis.toString(),
                10,
            );
        }
        if (opts.maxWaitingClients !== undefined) {
            this.maxWaitingClients = parseInt(
                opts.maxWaitingClients.toString(),
                10,
            );
        }

        this.max = parseInt((opts.max || 1).toString(), 10);
        this.min = parseInt((opts.min || 0).toString(), 10);
        this.max = Math.max(isNaN(this.max) ? 1 : this.max, 1);
        this.min = Math.min(isNaN(this.min) ? 0 : this.min, this.max);

        this.evictionRunIntervalMillis = opts.evictionRunIntervalMillis ||
            poolDefaults.evictionRunIntervalMillis;
        this.numTestsPerEvictionRun = opts.numTestsPerEvictionRun ||
            poolDefaults.numTestsPerEvictionRun;
        this.softIdleTimeoutMillis = opts.softIdleTimeoutMillis ||
            poolDefaults.softIdleTimeoutMillis;
        this.idleTimeoutMillis = opts.idleTimeoutMillis ||
            poolDefaults.idleTimeoutMillis;
        this.Promise = opts.Promise != null
            ? opts.Promise
            : poolDefaults.Promise;
    }
}

// Deferred Promise
class Deferred<T> {
    static readonly PENDING = 'PENDING';
    static readonly FULFILLED = 'FULFILLED';
    static readonly REJECTED = 'REJECTED';

    protected _state: string = Deferred.PENDING;
    protected _resolve!: (value: T) => void;
    protected _reject!: (reason?: any) => void;
    protected _promise: Promise<T>;

    constructor(PromiseImpl: PromiseConstructor = Promise) {
        this._promise = new PromiseImpl<T>((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
    }

    get state(): string {
        return this._state;
    }

    get promise(): Promise<T> {
        return this._promise;
    }

    reject(reason?: any): void {
        if (this._state !== Deferred.PENDING) {
            return;
        }
        this._state = Deferred.REJECTED;
        this._reject(reason);
    }

    resolve(value: T): void {
        if (this._state !== Deferred.PENDING) {
            return;
        }
        this._state = Deferred.FULFILLED;
        this._resolve(value);
    }
}

// Errors
class ExtendableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
        this.message = message;
        if (typeof Error.captureStackTrace === 'function') {
            Error.captureStackTrace(this, this.constructor);
        } else {
            this.stack = new Error(message).stack;
        }
    }
}

/**
 * Error thrown when a timeout occurs during resource operations.
 */
export class TimeoutError extends ExtendableError {
    constructor(message: string) {
        super(message);
    }
}

// Resource Request
function fbind<T extends any[], R>(
    fn: (...args: T) => R,
    ctx: any,
): (...args: T) => R {
    return function bound(...args: T): R {
        return fn.apply(ctx, args);
    };
}

/**
 * Represents a request for a resource from the pool with optional timeout support.
 * @template T The type of resource being requested
 */
export class ResourceRequest<T> extends Deferred<T> {
    protected _creationTimestamp: number;
    protected _timeout: ReturnType<typeof setTimeout> | null = null;

    constructor(ttl?: number, PromiseImpl: PromiseConstructor = Promise) {
        super(PromiseImpl);
        this._creationTimestamp = Date.now();
        if (ttl !== undefined) {
            this.setTimeout(ttl);
        }
    }

    setTimeout(delay: number): void {
        if (this._state !== ResourceRequest.PENDING) {
            return;
        }
        const ttl = parseInt(delay.toString(), 10);
        if (isNaN(ttl) || ttl <= 0) {
            throw new Error('delay must be a positive int');
        }
        const age = Date.now() - this._creationTimestamp;
        if (this._timeout) {
            this.removeTimeout();
        }
        this._timeout = setTimeout(
            fbind(this._fireTimeout, this),
            Math.max(ttl - age, 0),
        );
    }

    removeTimeout(): void {
        if (this._timeout) {
            clearTimeout(this._timeout);
        }
        this._timeout = null;
    }

    protected _fireTimeout(): void {
        this.reject(new TimeoutError('ResourceRequest timed out'));
    }

    override reject(reason?: any): void {
        this.removeTimeout();
        super.reject(reason);
    }

    override resolve(value: T): void {
        this.removeTimeout();
        super.resolve(value);
    }
}

// Resource Loan
class ResourceLoan<T> extends Deferred<void> {
    _creationTimestamp: number;
    pooledResource: PooledResource<T>;

    constructor(
        pooledResource: PooledResource<T>,
        PromiseImpl: PromiseConstructor = Promise,
    ) {
        super(PromiseImpl);
        this._creationTimestamp = Date.now();
        this.pooledResource = pooledResource;
    }

    override reject(): void {
        // Override to prevent rejection
    }
}

// Pooled Resource State Enum
enum PooledResourceStateEnum {
    ALLOCATED = 'ALLOCATED',
    IDLE = 'IDLE',
    INVALID = 'INVALID',
    RETURNING = 'RETURNING',
    VALIDATION = 'VALIDATION',
}

// Pooled Resource
class PooledResource<T> {
    creationTime: number;
    lastReturnTime: number | null = null;
    lastBorrowTime: number | null = null;
    lastIdleTime: number | null = null;
    obj: T;
    state: PooledResourceStateEnum;

    constructor(resource: T) {
        this.creationTime = Date.now();
        this.obj = resource;
        this.state = PooledResourceStateEnum.IDLE;
    }

    allocate(): void {
        this.lastBorrowTime = Date.now();
        this.state = PooledResourceStateEnum.ALLOCATED;
    }

    deallocate(): void {
        this.lastReturnTime = Date.now();
        this.state = PooledResourceStateEnum.IDLE;
    }

    invalidate(): void {
        this.state = PooledResourceStateEnum.INVALID;
    }

    test(): void {
        this.state = PooledResourceStateEnum.VALIDATION;
    }

    idle(): void {
        this.lastIdleTime = Date.now();
        this.state = PooledResourceStateEnum.IDLE;
    }

    returning(): void {
        this.state = PooledResourceStateEnum.RETURNING;
    }
}

/**
 * Default evictor implementation that determines when idle resources should be evicted.
 */
export class DefaultEvictor {
    /**
     * Determines whether a pooled resource should be evicted based on idle time and pool configuration.
     * @param config Eviction configuration including timeout values and minimum pool size
     * @param pooledResource The resource to evaluate for eviction
     * @param availableObjectsCount Current number of available objects in the pool
     * @returns true if the resource should be evicted, false otherwise
     */
    evict<T>(
        config: EvictionConfig,
        pooledResource: PooledResource<T>,
        availableObjectsCount: number,
    ): boolean {
        const idleTime = Date.now() - (pooledResource.lastIdleTime || 0);
        if (
            config.softIdleTimeoutMillis > 0 &&
            config.softIdleTimeoutMillis < idleTime &&
            config.min < availableObjectsCount
        ) {
            return true;
        }
        if (config.idleTimeoutMillis < idleTime) {
            return true;
        }
        return false;
    }
}

// Doubly Linked List Node
interface DoublyLinkedListNode<T> {
    prev: DoublyLinkedListNode<T> | null;
    next: DoublyLinkedListNode<T> | null;
    data: T;
}

/**
 * Doubly linked list implementation used internally by the pool for efficient queue operations.
 * @template T The type of data stored in the list
 */
export class DoublyLinkedList<T> {
    head: DoublyLinkedListNode<T> | null = null;
    tail: DoublyLinkedListNode<T> | null = null;
    length: number = 0;

    /**
     * Inserts a node at the beginning of the list.
     * @param node The node to insert
     */
    insertBeginning(node: DoublyLinkedListNode<T>): void {
        if (this.head === null) {
            this.head = node;
            this.tail = node;
            node.prev = null;
            node.next = null;
            this.length++;
        } else {
            this.insertBefore(this.head, node);
        }
    }

    /**
     * Inserts a node at the end of the list.
     * @param node The node to insert
     */
    insertEnd(node: DoublyLinkedListNode<T>): void {
        if (this.tail === null) {
            this.insertBeginning(node);
        } else {
            this.insertAfter(this.tail, node);
        }
    }

    /**
     * Inserts a new node after an existing node.
     * @param node The existing node
     * @param newNode The new node to insert
     */
    insertAfter(
        node: DoublyLinkedListNode<T>,
        newNode: DoublyLinkedListNode<T>,
    ): void {
        newNode.prev = node;
        newNode.next = node.next;
        if (node.next === null) {
            this.tail = newNode;
        } else {
            node.next.prev = newNode;
        }
        node.next = newNode;
        this.length++;
    }

    /**
     * Inserts a new node before an existing node.
     * @param node The existing node
     * @param newNode The new node to insert
     */
    insertBefore(
        node: DoublyLinkedListNode<T>,
        newNode: DoublyLinkedListNode<T>,
    ): void {
        newNode.prev = node.prev;
        newNode.next = node;
        if (node.prev === null) {
            this.head = newNode;
        } else {
            node.prev.next = newNode;
        }
        node.prev = newNode;
        this.length++;
    }

    /**
     * Removes a node from the list.
     * @param node The node to remove
     */
    remove(node: DoublyLinkedListNode<T>): void {
        if (node.prev === null) {
            this.head = node.next;
        } else {
            node.prev.next = node.next;
        }
        if (node.next === null) {
            this.tail = node.prev;
        } else {
            node.next.prev = node.prev;
        }
        node.prev = null;
        node.next = null;
        this.length--;
    }

    /**
     * Creates a new doubly linked list node with the given data.
     * @param data The data to store in the node
     * @returns A new doubly linked list node
     */
    static createNode<T>(data: T): DoublyLinkedListNode<T> {
        return {
            prev: null,
            next: null,
            data,
        };
    }
}

// Doubly Linked List Iterator
class DoublyLinkedListIterator<T> {
    protected _list: DoublyLinkedList<T>;
    protected _direction: 'prev' | 'next';
    protected _startPosition: 'tail' | 'head';
    protected _started: boolean = false;
    protected _cursor: DoublyLinkedListNode<T> | null = null;
    protected _done: boolean = false;

    constructor(
        doublyLinkedList: DoublyLinkedList<T>,
        reverse: boolean = false,
    ) {
        this._list = doublyLinkedList;
        this._direction = reverse === true ? 'prev' : 'next';
        this._startPosition = reverse === true ? 'tail' : 'head';
    }

    protected _advanceCursor(): void {
        if (this._started === false) {
            this._started = true;
            this._cursor = this._list[this._startPosition];
            return;
        }
        this._cursor = this._cursor ? this._cursor[this._direction] : null;
    }

    reset(): void {
        this._done = false;
        this._started = false;
        this._cursor = null;
    }

    remove(): boolean {
        if (
            this._started === false || this._done === true ||
            this._isCursorDetached()
        ) {
            return false;
        }
        if (this._cursor) {
            this._list.remove(this._cursor);
        }
        return true;
    }

    next(): IteratorResult<DoublyLinkedListNode<T>> {
        if (this._done === true) {
            return { done: true, value: undefined };
        }
        this._advanceCursor();
        if (this._cursor === null || this._isCursorDetached()) {
            this._done = true;
            return { done: true, value: undefined };
        }
        return {
            value: this._cursor,
            done: false,
        };
    }

    protected _isCursorDetached(): boolean {
        if (!this._cursor) return false;
        return this._cursor.prev === null && this._cursor.next === null &&
            this._list.tail !== this._cursor &&
            this._list.head !== this._cursor;
    }
}

// Deque Iterator
class DequeIterator<T> extends DoublyLinkedListIterator<T> {
    override next(): IteratorResult<any> {
        const result = super.next();
        if (result.value) {
            return { value: result.value.data, done: false };
        }
        return { done: true, value: undefined };
    }
}

/**
 * Double-ended queue (deque) implementation used internally by the pool.
 * @template T The type of elements stored in the deque
 */
export class Deque<T> {
    protected _list: DoublyLinkedList<T>;

    constructor() {
        this._list = new DoublyLinkedList<T>();
    }

    /**
     * Removes and returns the first element from the deque.
     * @returns The first element, or undefined if the deque is empty
     */
    shift(): T | undefined {
        if (this.length === 0) {
            return undefined;
        }
        const node = this._list.head;
        if (node) {
            this._list.remove(node);
            return node.data;
        }
        return undefined;
    }

    /**
     * Adds an element to the beginning of the deque.
     * @param element The element to add
     */
    unshift(element: T): void {
        const node = DoublyLinkedList.createNode(element);
        this._list.insertBeginning(node);
    }

    /**
     * Adds an element to the end of the deque.
     * @param element The element to add
     */
    push(element: T): void {
        const node = DoublyLinkedList.createNode(element);
        this._list.insertEnd(node);
    }

    /**
     * Removes and returns the last element from the deque.
     * @returns The last element, or undefined if the deque is empty
     */
    pop(): T | undefined {
        if (this.length === 0) {
            return undefined;
        }
        const node = this._list.tail;
        if (node) {
            this._list.remove(node);
            return node.data;
        }
        return undefined;
    }

    [Symbol.iterator](): Iterator<T> {
        return new DequeIterator(this._list);
    }

    /**
     * Returns an iterator that traverses the deque from head to tail.
     * @returns Iterator for the deque
     */
    iterator(): DequeIterator<T> {
        return new DequeIterator(this._list);
    }

    /**
     * Returns an iterator that traverses the deque from tail to head.
     * @returns Reverse iterator for the deque
     */
    reverseIterator(): DequeIterator<T> {
        return new DequeIterator(this._list, true);
    }

    /**
     * Gets the first element without removing it.
     * @returns The first element, or undefined if the deque is empty
     */
    get head(): T | undefined {
        if (this.length === 0) {
            return undefined;
        }
        const node = this._list.head;
        return node ? node.data : undefined;
    }

    /**
     * Gets the last element without removing it.
     * @returns The last element, or undefined if the deque is empty
     */
    get tail(): T | undefined {
        if (this.length === 0) {
            return undefined;
        }
        const node = this._list.tail;
        return node ? node.data : undefined;
    }

    /**
     * Gets the number of elements in the deque.
     * @returns The length of the deque
     */
    get length(): number {
        return this._list.length;
    }
}

// Queue
class Queue<T> extends Deque<any> {
    override push(resourceRequest: ResourceRequest<T>): void {
        const node = DoublyLinkedList.createNode(resourceRequest);
        resourceRequest.promise.catch(
            this._createTimeoutRejectionHandler(node),
        );
        this._list.insertEnd(node);
    }

    protected _createTimeoutRejectionHandler(
        node: DoublyLinkedListNode<ResourceRequest<T>>,
    ) {
        return (reason: any) => {
            if (reason.name === 'TimeoutError') {
                this._list.remove(node);
            }
        };
    }
}

/**
 * Priority queue implementation that manages multiple queues with different priority levels.
 * @template T The type of elements stored in the priority queue
 */
export class PriorityQueue<T extends ResourceRequest<any>> {
    protected _size: number;
    protected _slots: Queue<T>[];

    constructor(size: number) {
        this._size = Math.max(+size | 0, 1);
        this._slots = [];
        for (let i = 0; i < this._size; i++) {
            this._slots.push(new Queue<T>());
        }
    }

    /**
     * Gets the total number of elements across all priority levels.
     * @returns The total length
     */
    get length(): number {
        let _length = 0;
        for (let i = 0, slots = this._slots.length; i < slots; i++) {
            _length += this._slots[i].length;
        }
        return _length;
    }

    /**
     * Adds an element to the queue with the specified priority.
     * @param obj The element to add
     * @param priority The priority level (0 = highest priority)
     */
    enqueue(obj: T, priority?: number): void {
        priority = priority && +priority | 0 || 0;
        if (priority) {
            if (priority < 0 || priority >= this._size) {
                priority = this._size - 1;
            }
        }
        this._slots[priority].push(obj);
    }

    /**
     * Removes and returns the highest priority element from the queue.
     * @returns The highest priority element, or undefined if the queue is empty
     */
    dequeue(): T | undefined {
        for (let i = 0, sl = this._slots.length; i < sl; i += 1) {
            if (this._slots[i].length) {
                return this._slots[i].shift();
            }
        }
        return undefined;
    }

    /**
     * Gets the highest priority element without removing it.
     * @returns The highest priority element, or undefined if the queue is empty
     */
    get head(): T | undefined {
        for (let i = 0, sl = this._slots.length; i < sl; i += 1) {
            if (this._slots[i].length > 0) {
                return this._slots[i].head;
            }
        }
        return undefined;
    }

    /**
     * Gets the lowest priority element without removing it.
     * @returns The lowest priority element, or undefined if the queue is empty
     */
    get tail(): T | undefined {
        for (let i = this._slots.length - 1; i >= 0; i--) {
            if (this._slots[i].length > 0) {
                return this._slots[i].tail;
            }
        }
        return undefined;
    }
}

// Utils
function noop(): void {}

function reflector<T>(promise: Promise<T>): Promise<void> {
    return promise.then(noop, noop);
}

/**
 * Generic resource pool with Promise-based API. Can be used to reuse or throttle
 * usage of expensive resources such as database connections.
 * @template T The type of resource managed by this pool
 */
export class Pool<T> extends EventEmitter {
    /** Event emitted when factory.create() rejects */
    static readonly FACTORY_CREATE_ERROR = 'factoryCreateError';
    /** Event emitted when factory.destroy() rejects */
    static readonly FACTORY_DESTROY_ERROR = 'factoryDestroyError';

    protected _config: PoolOptions;
    protected _Promise: PromiseConstructor;
    protected _factory: Factory<T>;
    protected _draining: boolean = false;
    protected _started: boolean = false;
    protected _waitingClientsQueue: PriorityQueue<ResourceRequest<T>>;
    protected _factoryCreateOperations: Set<Promise<void>>;
    protected _factoryDestroyOperations: Set<Promise<void>>;
    protected _availableObjects: Deque<PooledResource<T>>;
    protected _testOnBorrowResources: Set<PooledResource<T>>;
    protected _testOnReturnResources: Set<PooledResource<T>>;
    protected _validationOperations: Set<Promise<boolean>>;
    protected _allObjects: Set<PooledResource<T>>;
    protected _resourceLoans: Map<T, ResourceLoan<T>>;
    protected _evictionIterator: DequeIterator<PooledResource<T>>;
    protected _evictor: DefaultEvictor;
    protected _scheduledEviction: ReturnType<typeof setTimeout> | null = null;

    constructor(
        Evictor: typeof DefaultEvictor,
        DequeImpl: typeof Deque,
        PriorityQueueImpl: typeof PriorityQueue,
        factory: Factory<T>,
        options?: Options,
    ) {
        super();
        validateFactory(factory);

        this._config = new PoolOptions(options);
        this._Promise = this._config.Promise;
        this._factory = factory;

        this._waitingClientsQueue = new PriorityQueueImpl<ResourceRequest<T>>(
            this._config.priorityRange,
        );
        this._factoryCreateOperations = new Set<Promise<void>>();
        this._factoryDestroyOperations = new Set<Promise<void>>();
        this._availableObjects = new DequeImpl<PooledResource<T>>();
        this._testOnBorrowResources = new Set<PooledResource<T>>();
        this._testOnReturnResources = new Set<PooledResource<T>>();
        this._validationOperations = new Set<Promise<boolean>>();
        this._allObjects = new Set<PooledResource<T>>();
        this._resourceLoans = new Map<T, ResourceLoan<T>>();
        this._evictionIterator = this._availableObjects.iterator();
        this._evictor = new Evictor();

        if (this._config.autostart === true) {
            this.start();
        }
    }

    protected _destroy(pooledResource: PooledResource<T>): void {
        pooledResource.invalidate();
        this._allObjects.delete(pooledResource);
        const destroyPromise = this._factory.destroy(pooledResource.obj);
        const wrappedDestroyPromise = this._config.destroyTimeoutMillis
            ? this._Promise.resolve(this._applyDestroyTimeout(destroyPromise))
            : this._Promise.resolve(destroyPromise);

        this._trackOperation(
            wrappedDestroyPromise,
            this._factoryDestroyOperations,
        )
            .catch((reason) => {
                this.emit(Pool.FACTORY_DESTROY_ERROR, reason);
            });
        this._ensureMinimum();
    }

    protected _applyDestroyTimeout(promise: Promise<void>): Promise<void> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new this._Promise<void>((_resolve, reject) => {
            timeout = setTimeout(() => {
                reject(new Error('destroy timed out'));
                timeout = undefined;
            }, this._config.destroyTimeoutMillis!);
        });
        const finalizeTimeout = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }
        };
        promise.then(finalizeTimeout, finalizeTimeout);
        return this._Promise.race([timeoutPromise, promise]);
    }

    protected _testOnBorrow(): boolean {
        if (this._availableObjects.length < 1) {
            return false;
        }
        const pooledResource = this._availableObjects.shift();
        if (!pooledResource) return false;

        pooledResource.test();
        this._testOnBorrowResources.add(pooledResource);
        const validationPromise = this._factory.validate!(pooledResource.obj);
        const wrappedValidationPromise = this._Promise.resolve(
            validationPromise,
        );

        this._trackOperation(
            wrappedValidationPromise,
            this._validationOperations,
        )
            .then((isValid) => {
                this._testOnBorrowResources.delete(pooledResource);
                if (isValid === false) {
                    pooledResource.invalidate();
                    this._destroy(pooledResource);
                    this._dispense();
                    return;
                }
                this._dispatchPooledResourceToNextWaitingClient(pooledResource);
            });
        return true;
    }

    protected _dispatchResource(): boolean {
        if (this._availableObjects.length < 1) {
            return false;
        }
        const pooledResource = this._availableObjects.shift();
        if (pooledResource) {
            this._dispatchPooledResourceToNextWaitingClient(pooledResource);
        }
        return false;
    }

    protected _dispense(): void {
        const numWaitingClients = this._waitingClientsQueue.length;
        if (numWaitingClients < 1) {
            return;
        }

        const resourceShortfall = numWaitingClients -
            this._potentiallyAllocableResourceCount;
        const actualNumberOfResourcesToCreate = Math.min(
            this.spareResourceCapacity,
            resourceShortfall,
        );

        for (let i = 0; actualNumberOfResourcesToCreate > i; i++) {
            this._createResource();
        }

        if (this._config.testOnBorrow === true) {
            const desiredNumberOfResourcesToMoveIntoTest = numWaitingClients -
                this._testOnBorrowResources.size;
            const actualNumberOfResourcesToMoveIntoTest = Math.min(
                this._availableObjects.length,
                desiredNumberOfResourcesToMoveIntoTest,
            );
            for (let i = 0; actualNumberOfResourcesToMoveIntoTest > i; i++) {
                this._testOnBorrow();
            }
        }

        if (this._config.testOnBorrow === false) {
            const actualNumberOfResourcesToDispatch = Math.min(
                this._availableObjects.length,
                numWaitingClients,
            );
            for (let i = 0; actualNumberOfResourcesToDispatch > i; i++) {
                this._dispatchResource();
            }
        }
    }

    protected _dispatchPooledResourceToNextWaitingClient(
        pooledResource: PooledResource<T>,
    ): boolean {
        const clientResourceRequest = this._waitingClientsQueue.dequeue();
        if (
            clientResourceRequest === undefined ||
            clientResourceRequest.state !== Deferred.PENDING
        ) {
            this._addPooledResourceToAvailableObjects(pooledResource);
            return false;
        }

        const loan = new ResourceLoan(pooledResource, this._Promise);
        this._resourceLoans.set(pooledResource.obj, loan);
        pooledResource.allocate();
        clientResourceRequest.resolve(pooledResource.obj);
        return true;
    }

    protected _trackOperation<U>(
        operation: Promise<U>,
        set: Set<Promise<U>>,
    ): Promise<U> {
        set.add(operation);
        return operation.then(
            (v) => {
                set.delete(operation);
                return this._Promise.resolve(v);
            },
            (e) => {
                set.delete(operation);
                return this._Promise.reject(e);
            },
        );
    }

    protected _createResource(): void {
        const factoryPromise = this._factory.create();
        const wrappedFactoryPromise = this._Promise.resolve(factoryPromise)
            .then((resource) => {
                const pooledResource = new PooledResource(resource);
                this._allObjects.add(pooledResource);
                this._addPooledResourceToAvailableObjects(pooledResource);
            });

        this._trackOperation(
            wrappedFactoryPromise,
            this._factoryCreateOperations,
        )
            .then(() => {
                this._dispense();
                return null;
            })
            .catch((reason) => {
                this.emit(Pool.FACTORY_CREATE_ERROR, reason);
                this._dispense();
            });
    }

    protected _ensureMinimum(): void {
        if (this._draining === true) {
            return;
        }
        const minShortfall = this._config.min - this._count;
        for (let i = 0; i < minShortfall; i++) {
            this._createResource();
        }
    }

    protected _evict(): void {
        const testsToRun = Math.min(
            this._config.numTestsPerEvictionRun,
            this._availableObjects.length,
        );
        const evictionConfig: EvictionConfig = {
            softIdleTimeoutMillis: this._config.softIdleTimeoutMillis,
            idleTimeoutMillis: this._config.idleTimeoutMillis,
            min: this._config.min,
        };

        for (let testsHaveRun = 0; testsHaveRun < testsToRun;) {
            const iterationResult = this._evictionIterator.next();
            if (
                iterationResult.done === true &&
                this._availableObjects.length < 1
            ) {
                this._evictionIterator.reset();
                return;
            }
            if (
                iterationResult.done === true &&
                this._availableObjects.length > 0
            ) {
                this._evictionIterator.reset();
                continue;
            }

            const resource = iterationResult.value!;
            const shouldEvict = this._evictor.evict(
                evictionConfig,
                resource,
                this._availableObjects.length,
            );
            testsHaveRun++;
            if (shouldEvict === true) {
                this._evictionIterator.remove();
                this._destroy(resource);
            }
        }
    }

    protected _scheduleEvictorRun(): void {
        if (this._config.evictionRunIntervalMillis > 0) {
            this._scheduledEviction = setTimeout(() => {
                this._evict();
                this._scheduleEvictorRun();
            }, this._config.evictionRunIntervalMillis);
        }
    }

    protected _descheduleEvictorRun(): void {
        if (this._scheduledEviction) {
            clearTimeout(this._scheduledEviction);
        }
        this._scheduledEviction = null;
    }

    /**
     * Starts the pool. If autostart is false, this must be called before acquiring resources.
     * Begins creating minimum resources and starts the evictor if configured.
     */
    start(): void {
        if (this._draining === true || this._started === true) {
            return;
        }
        this._started = true;
        this._scheduleEvictorRun();
        this._ensureMinimum();
    }

    /**
     * Acquires a resource from the pool. If no resources are available, the call will wait
     * until a resource becomes available or times out.
     * @param priority Optional priority for queuing (0 = highest priority)
     * @returns Promise that resolves to a resource from the pool
     * @example
     * ```typescript
     * const resource = await pool.acquire();
     * try {
     *   // Use the resource
     *   await resource.doSomething();
     * } finally {
     *   // Always release the resource back to the pool
     *   await pool.release(resource);
     * }
     * ```
     */
    acquire(priority?: number): Promise<T> {
        if (this._started === false && this._config.autostart === false) {
            this.start();
        }
        if (this._draining) {
            return this._Promise.reject(
                new Error('pool is draining and cannot accept work'),
            );
        }
        if (
            this.spareResourceCapacity < 1 &&
            this._availableObjects.length < 1 &&
            this._config.maxWaitingClients !== undefined &&
            this._waitingClientsQueue.length >= this._config.maxWaitingClients
        ) {
            return this._Promise.reject(
                new Error('max waitingClients count exceeded'),
            );
        }

        const resourceRequest = new ResourceRequest<T>(
            this._config.acquireTimeoutMillis,
            this._Promise,
        );
        this._waitingClientsQueue.enqueue(resourceRequest, priority);
        this._dispense();
        return resourceRequest.promise;
    }

    /**
     * Convenience method that handles acquiring a resource, passing it to a function,
     * and automatically releasing or destroying it based on the function's outcome.
     * @param fn Function to execute with the acquired resource
     * @param priority Optional priority for queuing (0 = highest priority)
     * @returns Promise that resolves to the return value of the function
     * @example
     * ```typescript
     * const result = await pool.use(async (dbClient) => {
     *   return await dbClient.query('SELECT * FROM users');
     * });
     * ```
     */
    use<U>(fn: (resource: T) => U | Promise<U>, priority?: number): Promise<U> {
        return this.acquire(priority).then((resource) => {
            return Promise.resolve(fn(resource)).then(
                (result) => {
                    this.release(resource);
                    return result;
                },
                (err) => {
                    this.destroy(resource);
                    throw err;
                },
            );
        });
    }

    /**
     * Checks if a resource is currently borrowed from this pool.
     * @param resource The resource to check
     * @returns true if the resource is currently borrowed, false otherwise
     */
    isBorrowedResource(resource: T): boolean {
        return this._resourceLoans.has(resource);
    }

    /**
     * Returns a resource to the pool, making it available for other clients.
     * The resource should have been previously acquired from this pool.
     * @param resource The resource to return to the pool
     * @returns Promise that resolves when the resource has been returned
     * @example
     * ```typescript
     * const resource = await pool.acquire();
     * try {
     *   // Use the resource
     * } finally {
     *   await pool.release(resource);
     * }
     * ```
     */
    release(resource: T): Promise<void> {
        const loan = this._resourceLoans.get(resource);
        if (loan === undefined) {
            return this._Promise.reject(
                new Error('Resource not currently part of this pool'),
            );
        }
        this._resourceLoans.delete(resource);
        loan.resolve();
        const pooledResource = loan.pooledResource;
        pooledResource.deallocate();
        this._addPooledResourceToAvailableObjects(pooledResource);
        this._dispense();
        return this._Promise.resolve();
    }

    /**
     * Destroys a resource instead of returning it to the pool. Use this when
     * you know the resource is no longer usable (e.g., connection timed out).
     * @param resource The resource to destroy
     * @returns Promise that resolves when the resource has been destroyed
     * @example
     * ```typescript
     * const resource = await pool.acquire();
     * try {
     *   // Use the resource
     * } catch (error) {
     *   // Resource is corrupted, destroy it
     *   await pool.destroy(resource);
     *   throw error;
     * } finally {
     *   // Normal case would release
     *   await pool.release(resource);
     * }
     * ```
     */
    destroy(resource: T): Promise<void> {
        const loan = this._resourceLoans.get(resource);
        if (loan === undefined) {
            return this._Promise.reject(
                new Error('Resource not currently part of this pool'),
            );
        }
        this._resourceLoans.delete(resource);
        loan.resolve();
        const pooledResource = loan.pooledResource;
        pooledResource.deallocate();
        this._destroy(pooledResource);
        this._dispense();
        return this._Promise.resolve();
    }

    protected _addPooledResourceToAvailableObjects(
        pooledResource: PooledResource<T>,
    ): void {
        pooledResource.idle();
        if (this._config.fifo === true) {
            this._availableObjects.push(pooledResource);
        } else {
            this._availableObjects.unshift(pooledResource);
        }
    }

    /**
     * Drains the pool by preventing new acquisitions and waiting for all borrowed
     * resources to be returned. This is typically called during application shutdown.
     * @returns Promise that resolves when all resources have been returned
     * @example
     * ```typescript
     * // During application shutdown
     * await pool.drain();
     * await pool.clear();
     * ```
     */
    drain(): Promise<void> {
        this._draining = true;
        return this.__allResourceRequestsSettled().then(() => {
            return this.__allResourcesReturned();
        }).then(() => {
            this._descheduleEvictorRun();
        });
    }

    protected __allResourceRequestsSettled(): Promise<void> {
        if (this._waitingClientsQueue.length > 0) {
            const tail = this._waitingClientsQueue.tail;
            if (tail) {
                return reflector(tail.promise);
            }
        }
        return this._Promise.resolve();
    }

    protected __allResourcesReturned(): Promise<void[]> {
        const ps = Array.from(this._resourceLoans.values())
            .map((loan) => loan.promise)
            .map(reflector);
        return this._Promise.all(ps);
    }

    /**
     * Clears the pool by destroying all available resources. Should typically be
     * called after drain() during application shutdown.
     * @returns Promise that resolves when all resources have been destroyed
     * @example
     * ```typescript
     * // During application shutdown
     * await pool.drain();
     * await pool.clear();
     * ```
     */
    clear(): Promise<void> {
        const reflectedCreatePromises = Array.from(
            this._factoryCreateOperations,
        ).map(reflector);
        return this._Promise.all(reflectedCreatePromises).then(() => {
            for (const resource of this._availableObjects) {
                this._destroy(resource);
            }
            const reflectedDestroyPromises = Array.from(
                this._factoryDestroyOperations,
            ).map(reflector);
            return reflector(this._Promise.all(reflectedDestroyPromises));
        });
    }

    /**
     * Waits for the pool to be ready (i.e., has at least the minimum number of resources available).
     * @returns Promise that resolves when the pool is ready
     * @example
     * ```typescript
     * const pool = createPool(factory, { min: 5, max: 10 });
     * await pool.ready(); // Waits until at least 5 resources are available
     * ```
     */
    ready(): Promise<void> {
        return new this._Promise<void>((resolve) => {
            const isReady = () => {
                if (this.available >= this.min) {
                    resolve();
                } else {
                    setTimeout(isReady, 100);
                }
            };
            isReady();
        });
    }

    /**
     * Gets the number of additional resources that can be created (max - current size).
     * @returns Number of resources that can still be created
     */
    get spareResourceCapacity(): number {
        return this._config.max -
            (this._allObjects.size + this._factoryCreateOperations.size);
    }

    /**
     * Gets the total number of resources in the pool (both available and borrowed).
     * @returns Total number of resources
     */
    get size(): number {
        return this._count;
    }

    /**
     * Gets the number of resources currently available for borrowing.
     * @returns Number of available resources
     */
    get available(): number {
        return this._availableObjects.length;
    }

    /**
     * Gets the number of resources currently borrowed by clients.
     * @returns Number of borrowed resources
     */
    get borrowed(): number {
        return this._resourceLoans.size;
    }

    /**
     * Gets the number of clients waiting to acquire a resource.
     * @returns Number of pending acquisition requests
     */
    get pending(): number {
        return this._waitingClientsQueue.length;
    }

    /**
     * Gets the maximum number of resources allowed in the pool.
     * @returns Maximum pool size
     */
    get max(): number {
        return this._config.max;
    }

    /**
     * Gets the minimum number of resources maintained in the pool.
     * @returns Minimum pool size
     */
    get min(): number {
        return this._config.min;
    }

    // protected getters
    protected get _potentiallyAllocableResourceCount(): number {
        return this._availableObjects.length +
            this._testOnBorrowResources.size +
            this._testOnReturnResources.size +
            this._factoryCreateOperations.size;
    }

    protected get _count(): number {
        return this._allObjects.size + this._factoryCreateOperations.size;
    }
}

/**
 * Creates a new resource pool with the given factory and options.
 * @template T The type of resource this pool will manage
 * @param factory Factory object with create, destroy, and optionally validate methods
 * @param config Optional configuration for the pool
 * @returns A new Pool instance
 * @example
 * ```typescript
 * const factory = {
 *   create: () => Promise.resolve(new DatabaseConnection()),
 *   destroy: (conn) => conn.close(),
 *   validate: (conn) => Promise.resolve(conn.isConnected())
 * };
 *
 * const pool = createPool(factory, {
 *   max: 10,
 *   min: 2,
 *   acquireTimeoutMillis: 30000
 * });
 * ```
 */
export function createPool<T>(factory: Factory<T>, config?: Options): Pool<T> {
    return new Pool(DefaultEvictor, Deque, PriorityQueue, factory, config);
}

// Default export for convenience
export default {
    Pool,
    Deque,
    PriorityQueue,
    DefaultEvictor,
    TimeoutError,
    createPool,
};
