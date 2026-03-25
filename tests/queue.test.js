const queue = require('../services/queue-service');

describe('Queue Service', () => {
  beforeEach(() => {
    queue.jobs.clear();
    queue.activeCount = 0;
  });

  test('görev kuyruğa eklenebilir', async () => {
    const { jobId } = await queue.enqueue('test', { data: 'hello' }, 'user1');
    expect(jobId).toBeDefined();
    const job = queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job.type).toBe('test');
  });

  test('handler kayıt ve çalıştırma', async () => {
    let processed = false;
    queue.registerHandler('test-job', async (payload) => {
      processed = true;
      return { ok: true };
    });

    const { jobId } = await queue.enqueue('test-job', { x: 1 });

    // İşlenmeyi bekle
    await new Promise(r => setTimeout(r, 100));
    expect(processed).toBe(true);

    const job = queue.getJob(jobId);
    expect(job.status).toBe('completed');
  });

  test('stats doğru dönmeli', async () => {
    const stats = queue.getStats();
    expect(stats).toHaveProperty('pending');
    expect(stats).toHaveProperty('processing');
    expect(stats).toHaveProperty('completed');
    expect(stats).toHaveProperty('failed');
  });

  test('getUserJobs kullanıcıya göre filtreler', async () => {
    await queue.enqueue('a', {}, 'user1');
    await queue.enqueue('b', {}, 'user2');
    const jobs = queue.getUserJobs('user1');
    expect(jobs.length).toBe(1);
    expect(jobs[0].userId).toBe('user1');
  });
});
