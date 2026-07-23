import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'studio-api.json');
const destination = path.join(root, 'dist', 'studio-api.json');

if (fs.existsSync(source) && !fs.existsSync(destination)) {
    fs.copyFileSync(source, destination);
    console.log(`Created ${destination}`);
}
