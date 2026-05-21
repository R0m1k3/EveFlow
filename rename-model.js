const fs = require('fs');
const path = require('path');

const paths = [
  path.join(__dirname, 'public', 'Eve', 'EVE.obj'),
  path.join(__dirname, 'Eve', 'EVE.obj')
];

paths.forEach(p => {
  const newPath = p + '.bin';
  if (fs.existsSync(p)) {
    fs.renameSync(p, newPath);
    console.log(`Renamed: ${p} -> ${newPath}`);
  } else {
    console.log(`Not found: ${p}`);
  }
});
