import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register(pathToFileURL('./.ts-transpile-loader.mjs').href, pathToFileURL('./'));
