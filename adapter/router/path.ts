export type SplitPath = [string, ...string[]] | undefined

export const PATH_CHARS = {
    SPACE: " ",
    TAB: "\t",
    NEWLINE: "\n",
    SLASH: "/",
} as const

export const ROUTE_TOKENS = {
    WILDCARD: "*",
    DOUBLE_WILDCARD: "**",
} as const

export function isNamedParam(segment: string): boolean {
    return segment.length > 1 && segment[0] === ":"
}

export function getNamedParamName(segment: string): string {
    return segment.slice(1)
}

/**
 * Trims leading and trailing whitespace characters from a string.
 * @param {string} value - The input string to be trimmed.
 * @return {string} The trimmed string.
 */
export function trimSpaces(value: string): string {
    while (
        value.startsWith(PATH_CHARS.SPACE) ||
        value.startsWith(PATH_CHARS.TAB) ||
        value.startsWith(PATH_CHARS.NEWLINE)
    ) {
        value = value.slice(1)
    }

    if (value.length == 0) {
        return ""
    }

    while (
        value.endsWith(PATH_CHARS.SPACE) ||
        value.endsWith(PATH_CHARS.TAB) ||
        value.endsWith(PATH_CHARS.NEWLINE)
    ) {
        value = value.slice(0, -1)
    }

    return value
}

/**
 * Splits a path into its components.
 * @param path The path to split.
 * @returns An array of strings representing the path components.
 *          undefined if the path is empty.
 */
export function splitPath(path: string | undefined): SplitPath {
    if (path == undefined) {
        return undefined
    }

    while (
        path.startsWith(PATH_CHARS.SLASH) ||
        path.startsWith(PATH_CHARS.SPACE)
    ) {
        path = path.slice(1)
    }

    if (path.length == 0) {
        return undefined
    }

    while (
        path.endsWith(PATH_CHARS.SLASH) ||
        path.endsWith(PATH_CHARS.SPACE)
    ) {
        path = path.slice(0, -1)
    }

    const splitPath = path
        .split(PATH_CHARS.SLASH)
        .map((part) => {
            while (
                part.startsWith(PATH_CHARS.SLASH) ||
                part.startsWith(PATH_CHARS.SPACE)
            ) {
                part = part.slice(1)
            }

            if (part.length == 0) {
                return ""
            }

            while (
                part.endsWith(PATH_CHARS.SLASH) ||
                part.endsWith(PATH_CHARS.SPACE)
            ) {
                part = part.slice(0, -1)
            }

            return part
        })
        .filter((v) => v.length != 0)
    if (splitPath.length == 0) {
        return undefined
    }

    return splitPath as SplitPath
}

export function splitRoutePath(path: string | undefined): SplitPath {
    const splittedPath = splitPath(path)

    if (
        splittedPath &&
        splittedPath.length > 1 &&
        splittedPath.slice(0, -1).includes(ROUTE_TOKENS.DOUBLE_WILDCARD)
    ) {
        throw new Error(
            `Invalid router path, ${ROUTE_TOKENS.DOUBLE_WILDCARD} must be the last part`
        )
    }

    return splittedPath as SplitPath
}

/**
 * Checks if a requested splitpath matches the routes splitpath.
 * Also resolves single (*) and double (** wildcards and :param named params.
 * `true`, named params object, or wildcarded path parts are returned if found and match.
 * `false` is returned if not.
 * @param requestPath the path to check
 * @param routeSelector the route selector to check against
 */
export function requestPathMatchesRouteDefinition(
    requestPath: SplitPath,
    routeSelector: SplitPath,
): string[] | Record<string, string> | boolean {
    if (
        requestPath == undefined &&
        routeSelector == undefined
    ) {
        return {}
    } else if (
        routeSelector == undefined
    ) {
        return false
    } else if (
        requestPath == undefined
    ) {
        if (routeSelector[0] == ROUTE_TOKENS.DOUBLE_WILDCARD) {
            return true
        }
        return false
    } else if (
        requestPath.length == 0
    ) {
        throw new Error("Invalid requestPath SplitPath length, got 0, expected at least 1")
    } else if (
        routeSelector.length == 0
    ) {
        throw new Error("Invalid routeSelector SplitPath length, got 0, expected at least 1")
    } else if (routeSelector[0] == ROUTE_TOKENS.DOUBLE_WILDCARD) {
        return requestPath
    } else if (routeSelector.length < requestPath.length) {
        if (routeSelector[routeSelector.length - 1] != ROUTE_TOKENS.DOUBLE_WILDCARD) {
            return false
        }
    }

    let pathParams: string[] | true = true
    let namedParams: Record<string, string> | undefined

    for (let i = 0; i < routeSelector.length; i++) {
        const selector = routeSelector[i]
        if (isNamedParam(selector)) {
            if (requestPath.length <= i) {
                return false
            }
            if (!namedParams) {
                namedParams = {}
            }
            namedParams[getNamedParamName(selector)] = requestPath[i]
        } else {
            switch (selector) {
                case ROUTE_TOKENS.WILDCARD:
                    if (requestPath.length <= i) {
                        return false
                    }
                    if (pathParams === true) {
                        pathParams = []
                    }
                    pathParams.push(requestPath[i])
                    break
                case ROUTE_TOKENS.DOUBLE_WILDCARD:
                    if (requestPath.length - i > 0) {
                        if (pathParams === true) {
                            pathParams = []
                        }
                        pathParams.push(...requestPath.slice(i))
                    }
                    return pathParams
                case requestPath[i]:
                    break
                default:
                    return false
            }
        }
    }

    if (namedParams) {
        return namedParams
    }

    return pathParams
}
