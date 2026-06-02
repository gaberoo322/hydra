// Fix ioredis default export for ESM — works at runtime, tsc needs this hint
declare module "ioredis" {
  export default class Redis {
    constructor(url?: string);
    constructor(port?: number, host?: string);
    get(key: string): Promise<string | null>;
    set(...args: any[]): Promise<any>;
    del(...args: any[]): Promise<number>;
    hget(key: string, field: string): Promise<string | null>;
    hset(key: string, ...args: any[]): Promise<number>;
    hgetall(key: string): Promise<Record<string, string>>;
    hdel(key: string, ...fields: string[]): Promise<number>;
    zadd(key: string, ...args: any[]): Promise<number>;
    zcard(key: string): Promise<number>;
    zrange(key: string, start: number, stop: number): Promise<string[]>;
    zrevrange(key: string, start: number, stop: number, ...args: any[]): Promise<string[]>;
    zrangebyscore(key: string, min: string | number, max: string | number): Promise<string[]>;
    zrem(key: string, ...members: string[]): Promise<number>;
    zscore(key: string, member: string): Promise<string | null>;
    lpush(key: string, ...values: string[]): Promise<number>;
    lpop(key: string): Promise<string | null>;
    lrange(key: string, start: number, stop: number): Promise<string[]>;
    llen(key: string): Promise<number>;
    rpush(key: string, ...values: string[]): Promise<number>;
    smembers(key: string): Promise<string[]>;
    srem(key: string, ...members: string[]): Promise<number>;
    sadd(key: string, ...members: string[]): Promise<number>;
    incr(key: string): Promise<number>;
    keys(pattern: string): Promise<string[]>;
    ltrim(key: string, start: number, stop: number): Promise<string>;
    ping(): Promise<string>;
    disconnect(): void;
    xadd(key: string, ...args: any[]): Promise<string>;
    xreadgroup(...args: any[]): Promise<any>;
    xack(...args: any[]): Promise<number>;
    xautoclaim(...args: any[]): Promise<any>;
    xgroup(...args: any[]): Promise<any>;
    xinfo(...args: any[]): Promise<any>;
    xpending(...args: any[]): Promise<any>;
    xrevrange(...args: any[]): Promise<any>;
    xlen(key: string): Promise<number>;
    duplicate(): Redis;
  }
}
