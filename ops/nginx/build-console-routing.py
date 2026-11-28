"""Extend the console route include while retaining portal and old asset paths."""
import argparse
from pathlib import Path
import re


def build_routing(route_tree, template, site_root, release):
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', release):
        raise ValueError('Invalid release identifier')
    section = route_tree.split('export interface FileRoutesByFullPath {', 1)[1].split('\n}', 1)[0]
    paths = re.findall(r"^  '([^']+)':", section, re.M)
    patterns = []
    for path in paths:
        path = path.rstrip('/')
        if not path:
            continue  # The independent portal owns /.
        parts = ['[^/]+' if part.startswith('$') else re.escape(part) for part in path.split('/')]
        patterns.append('/'.join(parts))
    if not patterns:
        raise ValueError('No console routes found')
    root = re.search(r'\broot\s+([^;]+);', template)
    location = re.search(r'location ~ "(\^.+?\$)"', template)
    fallback = re.search(r'try_files \$uri (@[a-zA-Z0-9_]+);', template)
    if root is None or location is None or fallback is None:
        raise ValueError('Unsupported console include')
    old_pattern = location.group(1)
    addition = '(?:' + '|'.join(sorted(set(patterns))) + ')/?'
    pattern = old_pattern
    if addition not in old_pattern:
        pattern = '^(?:' + old_pattern[1:-1] + '|' + addition + ')$'
    next_include = template.replace(location.group(0), 'location ~ "' + pattern + '"', 1)
    old_root = root.group(1)
    next_include = next_include.replace(old_root, str(site_root))
    next_include = re.sub(r'(X-Shiny-Frontend\s+")[^"]+("\s+always;)',
                          lambda match: match[1] + release + match[2], next_include)
    name = '@' + release.replace('-', '_') + '_previous_assets'
    if 'location ' + name in template:
        raise ValueError('Release fallback already exists')
    next_include = next_include.replace(fallback[0], 'try_files $uri ' + name + ';', 1)
    next_include += '\nlocation ' + name + ' {\n    root ' + old_root + ';\n    try_files $uri ' + fallback[1] + ';\n}\n'
    return next_include


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--routes', required=True, type=Path)
    parser.add_argument('--template', required=True, type=Path)
    parser.add_argument('--site-root', required=True, type=Path)
    parser.add_argument('--release', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = build_routing(args.routes.read_text(encoding='utf-8'), args.template.read_text(encoding='utf-8'), args.site_root, args.release)
    args.output.write_text(result, encoding='utf-8')
