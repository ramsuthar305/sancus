class UrlUtils {
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
            paramRegexPattern = '[a-zA-Z0-9\\-.@#]+';
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
