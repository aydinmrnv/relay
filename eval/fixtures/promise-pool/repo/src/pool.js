/** Runs an array of thunks with a cap on how many are in flight at once. */

export function runPool(tasks, concurrency = 4) {
  return new Promise((resolve, reject) => {
    const results = new Array(tasks.length);
    const errors = [];
    let started = 0;
    let finished = 0;

    if (tasks.length === 0) {
      resolve(results);
      return;
    }

    const startNext = () => {
      if (started >= tasks.length) return;
      const index = started;
      started += 1;

      Promise.resolve()
        .then(() => tasks[index]())
        .then(
          (value) => {
            results[index] = value;
          },
          (error) => {
            errors.push(error);
          },
        )
        .then(() => {
          finished += 1;
          if (finished === tasks.length) {
            if (errors.length > 0) reject(new AggregateError(errors, 'one or more tasks failed'));
            else resolve(results);
          } else {
            startNext();
          }
        });
    };

    for (let slot = 0; slot < Math.min(concurrency, tasks.length); slot += 1) startNext();
  });
}
