const requiredMajor = 22
const actualMajor = Number(process.versions.node.split('.', 1)[0])

if (actualMajor !== requiredMajor) {
	console.error(`This Companion module must be built and tested with Node.js ${requiredMajor}.x; found ${process.version}.`)
	console.error('Install/select Node 22 (for example: fnm use 22), then run the command again.')
	process.exit(1)
}
