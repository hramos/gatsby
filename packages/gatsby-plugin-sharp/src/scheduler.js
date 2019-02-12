const _ = require(`lodash`)
const ProgressBar = require(`progress`)
const existsSync = require(`fs-exists-cached`).sync
const queue = require(`async/queue`)
const processFile = require(`./process-file`)

const toProcess = {}
let totalJobs = 0
const q = queue((task, callback) => {
  task(callback)
}, 1)

const bar = new ProgressBar(
  `Generating image thumbnails [:bar] :current/:total :elapsed secs :percent`,
  {
    total: 0,
    width: 30,
  }
)

exports.scheduleJob = async (job, boundActionCreators, pluginOptions) => {
  const inputFileKey = job.file.absolutePath.replace(/\./g, `%2E`)
  const outputFileKey = job.outputPath.replace(/\./g, `%2E`)
  const jobPath = `${inputFileKey}.${outputFileKey}`

  // Check if the job has already been queued. If it has, there's nothing
  // to do, return.
  if (_.has(toProcess, jobPath)) {
    return _.get(toProcess, `${jobPath}.deferred.promise`)
  }

  // Check if the output file already exists so we don't redo work.
  if (existsSync(job.outputPath)) {
    return Promise.resolve(job)
  }

  let isQueued = false
  if (toProcess[inputFileKey]) {
    isQueued = true
  }

  // deferred naming comes from https://developer.mozilla.org/en-US/docs/Mozilla/JavaScript_code_modules/Promise.jsm/Deferred
  let deferred = {}
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = resolve
    deferred.reject = reject
  })

  totalJobs += 1

  _.set(toProcess, jobPath, {
    job: job,
    deferred,
  })

  if (!isQueued) {
    q.push(cb => {
      runJobs(inputFileKey, boundActionCreators, pluginOptions, cb)
    })
  }

  return deferred.promise
}

function runJobs(inputFileKey, boundActionCreators, pluginOptions, cb) {
  const jobs = _.values(toProcess[inputFileKey])
  const findDeferred = job => jobs.find(j => j.job === job).deferred
  const { job } = jobs[0]

  // Delete the input key from the toProcess list so more jobs can be queued.
  delete toProcess[inputFileKey]
  boundActionCreators.createJob(
    {
      id: `processing image ${job.file.absolutePath}`,
      imagesCount: _.values(toProcess[inputFileKey]).length,
    },
    { name: `gatsby-plugin-sharp` }
  )

  // We're now processing the file's jobs.
  let imagesFinished = 0
  bar.total = totalJobs

  try {
    const promises = processFile(
      job.file.absolutePath,
      jobs.map(job => job.job),
      pluginOptions
    ).map(promise =>
      promise
        .then(job => {
          findDeferred(job).resolve()
        })
        .catch(err => {
          findDeferred(job).reject({
            err,
            message: `Failed to process image ${job.file.absolutePath}`,
          })
        })
        .then(() => {
          imagesFinished += 1
          bar.tick()
          boundActionCreators.setJob(
            {
              id: `processing image ${job.file.absolutePath}`,
              imagesFinished,
            },
            { name: `gatsby-plugin-sharp` }
          )
        })
    )

    Promise.all(promises).then(() => {
      boundActionCreators.endJob(
        { id: `processing image ${job.file.absolutePath}` },
        { name: `gatsby-plugin-sharp` }
      )
      cb()
    })
  } catch (err) {
    jobs.forEach(({ deferred }) => {
      deferred.reject({
        err,
        message: err.message,
      })
    })
  }
}