import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const archivePattern = /^pavonine-teleprompter-(.+)\.tgz$/

function compareIdentifier(left, right) {
	const numericLeft = /^\d+$/.test(left)
	const numericRight = /^\d+$/.test(right)
	if (numericLeft && numericRight) return Number(left) - Number(right)
	if (numericLeft) return -1
	if (numericRight) return 1
	return left.localeCompare(right)
}

function compareVersions(left, right) {
	const parse = (version) => {
		const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
		if (!match) return undefined
		return { numbers: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? [] }
	}
	const parsedLeft = parse(left)
	const parsedRight = parse(right)
	if (!parsedLeft || !parsedRight) return left.localeCompare(right)
	for (let index = 0; index < parsedLeft.numbers.length; index++) {
		const difference = parsedLeft.numbers[index] - parsedRight.numbers[index]
		if (difference) return difference
	}
	if (!parsedLeft.prerelease.length) return parsedRight.prerelease.length ? 1 : 0
	if (!parsedRight.prerelease.length) return -1
	for (let index = 0; index < Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length); index++) {
		if (parsedLeft.prerelease[index] === undefined) return -1
		if (parsedRight.prerelease[index] === undefined) return 1
		const difference = compareIdentifier(parsedLeft.prerelease[index], parsedRight.prerelease[index])
		if (difference) return difference
	}
	return 0
}

export function releaseArchivesToDelete(files) {
	const releases = files
		.map((file) => ({ file, version: archivePattern.exec(file)?.[1] }))
		.filter((release) => release.version)
		.sort((left, right) => compareVersions(right.version, left.version))
	return releases.slice(2).map((release) => release.file)
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const directory = process.cwd()
	const files = await readdir(directory)
	const toDelete = releaseArchivesToDelete(files)
	for (const file of toDelete) await rm(path.join(directory, file))
	console.log(toDelete.length ? `Removed ${toDelete.join(', ')}` : 'No older release archives to remove')
}
