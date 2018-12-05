const Promise = require('bluebird');
const _ = require('lodash');
const schedule = require('node-schedule');
const pluralize = require('pluralize');
const axios = require('axios');

console.log('Starting build automation to:');
console.log('- Automatically merge pull requests (every 2 minutes)');

console.log('\nOperating on the following repositories:');
_.each(getRepoList(), r => console.log(`- ${r}`));

schedule.scheduleJob('*/2 * * * *', autoMergePullRequests);

function getRepoList() {
    return _(process.env.REPO_LIST).split(';').map(_.trim).compact().value();
}

async function autoMergePullRequests() {
    try {
        const repoResponses = await Promise.map(getRepoList(), async repo => {
            const repoPullsResponse = await axios.get(`https://api.github.com/repos/clarifyhealth/${repo}/pulls`, {
                params: {
                    state: 'open'
                },
                headers: {
                    Authorization: `token ${process.env.GITHUB_PERSONAL_ACCESS_TOKEN}`
                }
            });

            return repoPullsResponse.data;
        });

        const allPullRequests = _.flatten(repoResponses);

        console.log(`Found total of ${pluralize('pull request', allPullRequests.length, true)}.`);
        await Promise.each(allPullRequests, async p => {
            const issueComments = _.get(await axios.get(`https://api.github.com/repos/${p.head.repo.full_name}/issues/${p.number}/comments`, {
                headers: {
                    Authorization: `token ${process.env.GITHUB_PERSONAL_ACCESS_TOKEN}`
                }
            }), 'data');

            if (!_.find(issueComments, comment => _.toUpper(comment.body) === 'MERGE')) {
                // No instruction to merge
                return;
            }

            console.log(`Processing pull request #${p.number} by ${p.user.login} from ${p.head.repo.name}/${p.head.ref}.`);

            const pull = _.get(await axios.get(`https://api.github.com/repos/${p.head.repo.full_name}/pulls/${p.number}`, {
                headers: {
                    Authorization: `token ${process.env.GITHUB_PERSONAL_ACCESS_TOKEN}`
                }
            }), 'data');

            if (pull.mergeable_state !== 'clean' || !pull.mergeable && !pull.rebaseable) {
                // Not ready to merge
                console.log(`    #${p.number} - Skipping pull request because it is not yet ready.`);
                return;
            }

            console.log(`    #${p.number} - Merging pull request with "${pull.rebaseable ? 'rebase' : 'merge'}".`);
            const mergeResult = _.get(await axios.put(`https://api.github.com/repos/${p.head.repo.full_name}/pulls/${p.number}/merge`,
                {
                    merge_method: pull.rebaseable ? 'rebase' : 'merge',
                    sha: p.head.sha,
                    commit_title: `Merge pull request #${p.number} from ${p.head.repo.name}/${p.head.ref}`
                },
                {
                    headers: {
                        Authorization: `token ${process.env.GITHUB_PERSONAL_ACCESS_TOKEN}`
                }
            }), 'data');

            if (mergeResult.merged) {
                console.log(`    #${p.number} - Successfully merged pull request.`);
                try {
                    console.log(`    #${p.number} - Deleting branch ${p.head.repo.name}/${p.head.ref}.`);
                    await axios.delete(`https://api.github.com/repos/${p.head.repo.full_name}/git/refs/heads/${p.head.ref}`, {
                        headers: {
                            Authorization: `token ${process.env.GITHUB_PERSONAL_ACCESS_TOKEN}`
                        }
                    });
                    console.log(`    #${p.number} - Successfully deleted branch ${p.head.repo.name}/${p.head.ref}.`);
                } catch (e) {
                    console.log(`    #${p.number} - Failed to delete branch ${p.head.repo.name}/${p.head.ref} after merging pull request ${p.number} by ${p.user.login}.`);
                }
            } else {
                console.log(`    #${p.number} - FAILED to merge pull request ${p.number} by ${p.user.login} from ${p.head.repo.name}/${p.head.ref}.`);
                console.log(`    #${p.number} - Reason: ${mergeResult.message}`);
            }
        })
    }
    catch (e) {
        console.log(e);
    }
}
