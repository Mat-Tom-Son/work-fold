import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
async function sourceEntry(root, path) {
  const absolute = join(root, path);
  const stat = await lstat(absolute).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!stat) return null; // A deleted tracked file is absent from this working tree.
  if (stat.isSymbolicLink()) return { path, kind: 'symlink', target: await readlink(absolute) };
  if (!stat.isFile()) throw new Error(`Unsupported source entry: ${path}`);
  return { path, kind: 'file', bytes: stat.size, executable: Boolean(stat.mode & 0o111), sha256: await digest(absolute) };
}

/** Preserve the actual reviewed working tree, including uncommitted files.
 * Git defines its inputs; GNU tar owns the archive format. No ignored files,
 * dependency directories, generated outputs or symlink targets are followed. */
export async function captureLinuxSource(root, output, version) {
  root = resolve(root); output = resolve(output);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid candidate version');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const sourceCommit = git(['rev-parse', 'HEAD']).trim();
  const status = git(['status', '--porcelain']);
  const paths = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  const entries = [];
  for (const path of paths) {
    if (path.startsWith('/') || path.split('/').includes('..') || path.startsWith('.git/')) throw new Error('Invalid source path');
    const entry = await sourceEntry(root, path); if (entry) entries.push(entry);
  }
  if (!entries.length || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Missing source identity');
  await mkdir(output, { recursive: true });
  const scratch = await mkdtemp(join(output, '.linux-source-'));
  try {
    const archiveName = `work-fold-${version}-linux-source.tar.gz`;
    const manifestName = `work-fold-${version}-linux-source.json`;
    const list = join(scratch, 'files');
    await writeFile(list, entries.map(entry => entry.path + '\0').join(''));
    const archive = join(scratch, archiveName);
    execFileSync('tar', ['--create', '--gzip', '--file', archive, '--directory', root,
      '--format=posix', '--pax-option=delete=atime,delete=ctime', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
      '--no-recursion', '--null', '--files-from', list], { stdio: 'pipe', timeout: 120_000 });
    // Reject edits during capture before binding an archive to build output.
    for (const entry of entries) {
      if (JSON.stringify(await sourceEntry(root, entry.path)) !== JSON.stringify(entry)) throw new Error(`Source changed while capturing: ${entry.path}`);
    }
    if (git(['status', '--porcelain']) !== status || git(['rev-parse', 'HEAD']).trim() !== sourceCommit) throw new Error('Source checkout changed while capturing');
    const archiveEvidence = { name: archiveName, bytes: (await lstat(archive)).size, sha256: await digest(archive) };
    const manifest = { schema: 'work-fold.linux-source.v1', version, sourceCommit, sourceDirty: Boolean(status.trim()), archive: archiveEvidence, entries };
    const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
    await writeFile(join(scratch, manifestName), manifestBytes);
    for (const name of [archiveName, manifestName]) {
      const destination = join(output, name);
      const existing = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (existing) {
        if (!existing.isFile() || await digest(destination) !== await digest(join(scratch, name))) throw new Error(`Source evidence already exists with different bytes: ${name}. Choose a higher version.`);
      } else await rename(join(scratch, name), destination);
    }
    return { sourceCommit, sourceDirty: manifest.sourceDirty, sourceEvidence: {
      archive: archiveEvidence,
      manifest: { name: manifestName, bytes: Buffer.byteLength(manifestBytes), sha256: createHash('sha256').update(manifestBytes).digest('hex') },
    } };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
