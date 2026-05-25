import { ResponseBuilder, HTTP_STATUS } from "./responseBuilder";
import type {
  Context as ContextInterface,
  NRequest as EnhancedRequest,
} from "./types";

export class Context implements ContextInterface {
  _data: Record<string, unknown> = {};

  constructor(
    public readonly req: EnhancedRequest,
    public readonly res: ResponseBuilder,
  ) {}

  set(key: string, value: unknown): void {
    this._data[key] = value;
  }

  get<T = unknown>(key: string): T {
    return this._data[key] as T;
  }

  get data(): Record<string, unknown> {
    return this._data;
  }

  status(code: number): this {
    this.res.statusCode = code;
    return this;
  }

  json(data: unknown, code?: number): void {
    this.res.sendJson(data, code);
  }

  text(body: string, code?: number): void {
    this.res.sendText(body, code);
  }

  html(body: string, code?: number): void {
    this.res.sendHtml(body, code);
  }

  redirect(url: string, code: number = HTTP_STATUS.TEMPORARY_REDIRECT): void {
    this.res.sendRedirectCustom(url, code);
  }

  notFound(msg?: string): void {
    this.status(HTTP_STATUS.NOT_FOUND).text(msg ?? "Not found");
  }

  error(msg: string, code: number = HTTP_STATUS.INTERNAL_SERVER_ERROR): void {
    this.status(code).text(msg);
  }

  get url(): URL {
    return new URL(this.req.url);
  }

  get method(): string {
    return this.req.method;
  }

  get headers(): Headers {
    return this.req.headers;
  }

  get path(): string {
    return this.url.pathname;
  }

  build(): Response {
    return this.res.build();
  }
}
