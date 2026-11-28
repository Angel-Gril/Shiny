import importlib.util
from pathlib import Path
import re
import unittest

spec = importlib.util.spec_from_file_location('routing', Path(__file__).with_name('build-console-routing.py'))
routing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routing)


class ConsoleRoutingTests(unittest.TestCase):
    def test_new_console_routes_keep_portal_root_and_old_asset_chain(self):
        tree = "export interface FileRoutesByFullPath {\n  '/': typeof Index\n  '/request-processing/': typeof Settings\n  '/oauth/plugin/$key/callback': typeof Callback\n}\n"
        template = '''location ~ "^(?:/pricing|/login)/?$" {
    root /releases/old/site;
    try_files /index.html =404;
    add_header X-Shiny-Frontend "old" always;
}
location ^~ /static/ {
    root /releases/old/site;
    try_files $uri @previous;
}
location @previous {
    root /releases/older/site;
    try_files $uri =404;
}
'''
        result = routing.build_routing(tree, template, Path('/releases/new/site'), 'web-rc51')
        pattern = re.search(r'location ~ "([^"]+)"', result)[1]
        for path in ['/request-processing', '/request-processing/', '/oauth/plugin/test/callback', '/pricing', '/login']:
            self.assertRegex(path, pattern)
        for path in ['/', '/docs/start', '/downloads', '/api/status', '/oauth/plugin/a/b/callback']:
            self.assertIsNone(re.fullmatch(pattern, path), path)
        self.assertIn('try_files $uri @web_rc51_previous_assets;', result)
        self.assertIn('root /releases/older/site;\n    try_files $uri =404;', result)
        self.assertIn('root /releases/old/site;\n    try_files $uri @previous;', result)
        self.assertIn('X-Shiny-Frontend "web-rc51"', result)

        # A second release with the same route tree must not keep appending
        # another copy of every route to Nginx's bounded regex parameter.
        repeated = routing.build_routing(tree, result, Path('/releases/next/site'), 'web-next')
        repeated_pattern = re.search(r'location ~ "([^"]+)"', repeated)[1]
        self.assertEqual(pattern, repeated_pattern)
        self.assertIn('root /releases/new/site;\n    try_files $uri @web_rc51_previous_assets;', repeated)


if __name__ == '__main__':
    unittest.main()
