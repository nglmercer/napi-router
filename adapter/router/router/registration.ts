import { splitRoutePath } from "../path"
import { parseHttpMethods, HttpMethodString } from "../method"
import { isMergeableEndpointRoute, mergeRequestMiddlewares, unmergeRequestMiddleware } from "../middleware"
import type { EndpointRoute, RequestMiddleware } from "../types"

/**
 * Register a handler to run for all incoming requests.
 * @param routes The routes array to add to
 * @param mergeHandlers Whether to merge handlers
 * @param method The HTTP method to run the handler on (undefined = all)
 * @param path The path to run the handler on (undefined = all)
 * @param handlers The handler(s) to run
 * @returns The updated routes array
 */
export function use(
    routes: EndpointRoute[],
    mergeHandlers: boolean,
    method: "*" | HttpMethodString,
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
): EndpointRoute[] {
    if (typeof handler != "function") {
        throw new Error("no handler provided, type: " + typeof handler)
    }

    handlers = [
        handler,
        ...handlers
    ]

    const route: EndpointRoute = {
        splitPath: splitRoutePath(path),
        method: parseHttpMethods(method),
        handler: handler
    }

    if (mergeHandlers) {
        const lastDef = routes.pop()
        if (lastDef) {
            if (
                isMergeableEndpointRoute(
                    lastDef,
                    route,
                )
            ) {
                handlers.unshift(lastDef.handler)
            } else {
                routes.push(lastDef)
            }
        }
    }

    route.handler = mergeRequestMiddlewares(
        ...unmergeRequestMiddleware(
            ...handlers
        )
    )

    routes.push(route)
    return routes
}

/**
 * Creates a GET route registration function.
 * @param routes The routes array to add to
 * @param mergeHandlers Whether to merge handlers
 * @param path The path to register the handler for.
 * @param handler The handler function for the route.
 * @param handlers Additional middleware functions to apply to the route.
 * @returns The updated routes array.
 */
export function get(
    routes: EndpointRoute[],
    mergeHandlers: boolean,
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
): EndpointRoute[] {
    return use(routes, mergeHandlers, "GET", path, handler, ...handlers)
}

/**
 * Register a handler to run on incoming POST requests.
 * @param routes The routes array to add to
 * @param mergeHandlers Whether to merge handlers
 * @param path The path to run the handler on
 * @param handler The handler(s) to run
 * @returns The updated routes array
 */
export function post(
    routes: EndpointRoute[],
    mergeHandlers: boolean,
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
): EndpointRoute[] {
    return use(routes, mergeHandlers, "POST", path, handler, ...handlers)
}

/**
 * Register a PUT route.
 * @param routes The routes array to add to
 * @param mergeHandlers Whether to merge handlers
 * @param path The path to match.
 * @param handler The handler for the route.
 * @param handlers Additional handlers to run before the main handler.
 * @returns The updated routes array.
 */
export function put(
    routes: EndpointRoute[],
    mergeHandlers: boolean,
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
): EndpointRoute[] {
    return use(routes, mergeHandlers, "PUT", path, handler, ...handlers)
}

/**
 * Register a middleware function to handle DELETE requests to `path`.
 * @param routes The routes array to add to
 * @param mergeHandlers Whether to merge handlers
 * @param path The path to register the handler for.
 * @param handler The middleware function to call.
 * @param handlers Additional middleware functions to call.
 * @returns The updated routes array.
 */
export function deleteMethod(
    routes: EndpointRoute[],
    mergeHandlers: boolean,
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
): EndpointRoute[] {
    return use(routes, mergeHandlers, "DELETE", path, handler, ...handlers)
}

/**
 * Register a middleware function to handle PATCH requests to `path`.
 * @param routes The routes array to add to
 * @param mergeHandlers Whether to merge handlers
 * @param path The path to register the handler for.
 * @param handler The middleware function to call.
 * @param handlers Additional middleware functions to call.
 * @returns The updated routes array.
 */
export function patch(
    routes: EndpointRoute[],
    mergeHandlers: boolean,
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
): EndpointRoute[] {
    return use(routes, mergeHandlers, "PATCH", path, handler, ...handlers)
}

/**
 * Add a route for the HTTP TRACE method.
 * The TRACE method is used to invoke a remote, application-layer loop-back
 * of the request message.
 * @param routes The routes array to add to
 * @param mergeHandlers Whether to merge handlers
 * @param path The path this route will match.
 * @param handler The handler to invoke when this route is matched.
 * @param handlers Additional handlers to run when this route is matched.
 * @returns The updated routes array.
 */
export function trace(
    routes: EndpointRoute[],
    mergeHandlers: boolean,
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
): EndpointRoute[] {
    return use(routes, mergeHandlers, "TRACE", path, handler, ...handlers)
}

/**
 * Registers a route for the `HEAD` HTTP method.
 * @param routes The routes array to add to
 * @param mergeHandlers Whether to merge handlers
 * @param path The route path.
 * @param handler The handler function for the route.
 * @param handlers Additional middleware functions to apply to the route.
 * @returns The updated routes array.
 */
export function head(
    routes: EndpointRoute[],
    mergeHandlers: boolean,
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
): EndpointRoute[] {
    return use(routes, mergeHandlers, "HEAD", path, handler, ...handlers)
}

/**
 * Register a handler to run for CONNECT requests on the given path.
 * @param routes The routes array to add to
 * @param mergeHandlers Whether to merge handlers
 * @param path The path to run the handler on
 * @param handler The handler to run
 * @returns The updated routes array.
 */
export function connect(
    routes: EndpointRoute[],
    mergeHandlers: boolean,
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
): EndpointRoute[] {
    return use(routes, mergeHandlers, "CONNECT", path, handler, ...handlers)
}

/**
 * Register a handler to run on OPTIONS requests.
 * @param routes The routes array to add to
 * @param mergeHandlers Whether to merge handlers
 * @param path The path to run the handler on (undefined = all)
 * @param handler The handler(s) to run
 * @returns The updated routes array.
 */
export function options(
    routes: EndpointRoute[],
    mergeHandlers: boolean,
    path: string,
    handler: RequestMiddleware,
    ...handlers: RequestMiddleware[]
): EndpointRoute[] {
    return use(routes, mergeHandlers, "OPTIONS", path, handler, ...handlers)
}
