class UrlUtils {
  /** True when any path segment is "." or ".." (also percent-encoded), which upstreams may resolve to another route. */
  public static hasDotSegment(path: string): boolean {
    return path.split('/').some((seg) => {
      let s = seg;
      try { s = decodeURIComponent(seg); } catch { /* malformed escapes: judge the raw text */ }
      return s === '.' || s === '..';
    });
  }

  public static extractServiceName(path: string): string | null {
    const serviceNameRegex = /\/api\/([^/]+)/;
    const match = path.match(serviceNameRegex);
    if (!match || match.length < 2) {
      return null;
    }
    return match[1];
  }
  public static extractPathWithQuery(path: string): string | null {
    const serviceNameRegex = /\/api\/[^/]+(.*)/;
    const match = path.match(serviceNameRegex);
    if (!match || match.length < 2) {
      return null;
    }
    return match[1];
  }

  public static extractPathWithoutQuery(path: string): string | null {
    const pathWithoutQueryRegex = /^\/api\/[^/]+(\/[^?]*)/;
    const match = path.match(pathWithoutQueryRegex);
    if (!match || match.length < 2) {
        return null;
    }
    return match[1];
}

  public static generateApiPathRegex(apiPathPattern: string): RegExp {
    const paramRegex = /{(\w+):(\w+)}/g;
    const regexPattern = apiPathPattern.replace(
      paramRegex,
      (match, paramType, paramName) => {
        let paramRegexPattern;
        switch (paramType) {
          case 'int':
          case 'numeric':
            paramRegexPattern = '\\d+';
            break;
          case 'str':
            // Allow underscores, colons, and other common characters in string params (e.g., "stays_list", "hotel_expert_chat", "tour_live_data:6815a2fee8ab27cae1a48e6a")
            paramRegexPattern = '[a-zA-Z0-9_\\-.@#:]+';
            break;
          default:
            paramRegexPattern = '\\w+';
            break;
        }
        return `(${paramRegexPattern})`;
      }
    );

    return new RegExp(`^${regexPattern}$`);
  }
}

export default UrlUtils;
