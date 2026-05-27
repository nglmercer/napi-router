const RAW_RESPONSE_BRAND = Symbol("RawResponse");

export class RawResponse {
  readonly [RAW_RESPONSE_BRAND] = true;
  static readonly BRAND = RAW_RESPONSE_BRAND;

  statusCode: number = 200;
  headers: string[] = [];
  #body: Uint8Array | string | null = null;

  get body(): Uint8Array | string | null {
    return this.#body;
  }

  static isRawResponse(val: unknown): val is RawResponse {
    return val instanceof RawResponse;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  header(name: string, value: string): this {
    this.headers.push(name, value);
    return this;
  }

  setBody(value: string | Uint8Array | ArrayBuffer | null): this {
    if (value === null) {
      this.#body = null;
    } else if (typeof value === "string") {
      this.#body = value;
    } else if (value instanceof Uint8Array) {
      this.#body = value;
    } else {
      this.#body = new Uint8Array(value);
    }
    return this;
  }

  json(data: unknown): this {
    this.#body = JSON.stringify(data);
    this.header("content-type", "application/json");
    return this;
  }

  text(data: string): this {
    this.#body = data;
    this.header("content-type", "text/plain; charset=UTF-8");
    return this;
  }

  html(data: string): this {
    this.#body = data;
    this.header("content-type", "text/html; charset=UTF-8");
    return this;
  }

  redirect(url: string, status: number = 307): this {
    this.statusCode = status;
    this.header("location", url);
    return this;
  }

  reset(): this {
    this.statusCode = 200;
    this.headers = [];
    this.#body = null;
    return this;
  }
}
