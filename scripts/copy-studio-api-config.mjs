import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');
for (const filename of ['studio-api.json', '.env']) {
    const source = path.join(root, filename);
    const destination = path.join(root, 'dist', filename);
    if (fs.existsSync(source) && !fs.existsSync(destination)) {
        fs.copyFileSync(source, destination);
        console.log(`Created ${destination}`);
    }
}
