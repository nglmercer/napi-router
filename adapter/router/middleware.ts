import type {
  Context,
  EndpointRoute,
  RequestMiddleware,
  MergedRequestMiddleware,
} from "./types";
import { PATH_CHARS } from "./path";

export function unmergeRequestMiddleware(
  ...middlewares: RequestMiddleware[]
): RequestMiddleware[] {
  const foundMiddlewares: RequestMiddleware[] = [];

  for (const middleware of middlewares) {
    if (isMergedRequestMiddleware(middleware)) {
      foundMiddlewares.push(...unmergeRequestMiddleware(...middleware.base));
    } else {
      foundMiddlewares.push(middleware);
    }
  }

  return foundMiddlewares;
}

export function mergeRequestMiddlewares(
  ...middlewares: RequestMiddleware[]
): MergedRequestMiddleware | RequestMiddleware {
  if (middlewares.length == 0) {
    throw new Error("no middlewares specified");
  } else if (middlewares.length == 1) {
    return middlewares[0];
  }

  middlewares = unmergeRequestMiddleware(...middlewares);

  const mergedAsync = async (
    initialDefIndex: number,
    promise: Promise<void | Response> | Response,
    ctx: Context,
  ): Promise<Response | void> => {
    const res = ctx.res;
    const req = ctx.req;
    if (promise instanceof Response) {
      return promise;
    }
    const result = await promise;
    if (result instanceof Response) {
      return result;
    }

    if (res.submit === true || req.upgraded === true) {
      return;
    }

    for (let i = initialDefIndex + 1; i < middlewares.length; i++) {
      const middleware = middlewares[i];
      const p = middleware(ctx);
      if (p instanceof Response) {
        return p;
      }
      if (p && p.then != undefined) {
        await p;
      }

      if ((res.submit as boolean) === true || req.upgraded === true) {
        return;
      }
    }
  };

  const baseMerged: RequestMiddleware = (ctx) => {
    const res = ctx.res;
    const req = ctx.req;
    for (let i = 0; i < middlewares.length; i++) {
      const middleware = middlewares[i];
      const p = middleware(ctx);
      if (p instanceof Response) {
        return p;
      }
      if (p && p.then != undefined) {
        return mergedAsync(i, p, ctx);
      }

      if (res.submit === true || req.upgraded === true) {
        return;
      }
    }
  };

  const merged = baseMerged as unknown as MergedRequestMiddleware;
  merged.base = middlewares;
  return merged;
}

export function isMergedRequestMiddleware(
  middleware: RequestMiddleware,
): middleware is MergedRequestMiddleware {
  return Array.isArray((middleware as unknown as MergedRequestMiddleware).base);
}

export function isMergeableEndpointRoute(
  route: EndpointRoute,
  route2: EndpointRoute,
): boolean {
  if (route.method !== route2.method) {
    return false;
  }

  if (route.splitPath == undefined && route2.splitPath == undefined) {
    return true;
  } else if (
    route.splitPath != undefined &&
    route2.splitPath != undefined &&
    route.splitPath.join(PATH_CHARS.SLASH) ==
      route2.splitPath.join(PATH_CHARS.SLASH)
  ) {
    return true;
  }
  return false;
}
