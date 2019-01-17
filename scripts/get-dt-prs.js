// @ts-check

const https = require("https");
const fs = require("fs");

function fileNameOfPage(index) {
    return `data/page${index}.json`;
}

const token = fs.readFileSync("../../api-auth-token.txt", {encoding: "utf-8"});
const urlPattern = `/repos/DefinitelyTyped/DefinitelyTyped/pulls?state=all&sort=created&per_page=100&page=`;

const opts = {
    hostname: "api.github.com",
    port: 443,
    headers: {
        "User-Agent": "RyanCavanaugh/home",
        "Authorization": `token ${token}`
    },
    method: "GET"
};

function getPage(index, done, doFetch) {
    const fileName = fileNameOfPage(index);

    if (fs.existsSync(fileName)) {
        console.log(`Page ${index} already exists`);
        next();
    } else {
        if (doFetch) {
            console.log(`Fetch page ${index}...`);

            let data = "";
            const req = https.request({...opts, path: urlPattern + index}, res => {
                res.on("data", d => {
                    data = data + d.toString();
                });
        
                res.on("error", err => {
                    throw err;
                });
        
                res.on("end", () => {
                    fs.writeFile(fileNameOfPage(index), data, { encoding: "utf8" }, () => {
                        const parsed = JSON.parse(data);
                        if (parsed.length === 100) {
                            next();
                        } else {
                            done();
                        }
                    });
                });
            });
            req.end();
        } else {
            done();
        }
    }

    function next() {
        getPage(index + 1, done);
    }
}

const fields = ["#", "Date Opened", "Month Opened", "Author", "Date Closed", "Days Open"];
function parse() {
    let i = 0;
    const lines = [fields.join(",")];

    const allPrs = [];

    while (fs.existsSync(fileNameOfPage(i))) {
        const data = JSON.parse(fs.readFileSync(fileNameOfPage(i), { encoding: "utf8" }));
        for (const pr of data) {
            allPrs.push(pr);
            const line = [];
            const created = new Date(pr.created_at);
            const closed = pr.closed_at === null ? new Date() : new Date(pr.closed_at);
            line.push(pr.number);
            line.push(created.toLocaleDateString());
            line.push(`${created.getFullYear()}-${(created.getMonth() + 1).toString().padStart(2, "0")}`);
            line.push(pr.user.login);
            line.push(closed.toLocaleDateString());
            line.push(Math.ceil((+closed - +created) / (1000 * 60 * 60 * 24)));
            lines.push(line.join(","));
        }
        i++;
    }
    fs.writeFileSync("prs.csv", lines.join("\r\n"), { encoding: "utf8"} );

    let startDate = new Date("1/1/2017");
    const now = new Date();
    let week = 0;
    const dateLines = [["Date", "Week", "Open PR Count", "Closed PR Count", "Closed Today", "Opened Today", "Net Debt"].join(",")];
    let lastCloseCount = 0, lastTotalCount = 0;
    while (startDate < now) {
        let openCount = 0, closeCount = 0, totalCount = 0;
        for (const pr of allPrs) {
            if (+(new Date(pr.created_at)) < +startDate) {
                if ((pr.closed_at !== null) && +(new Date(pr.closed_at)) < +startDate) {
                    closeCount++;
                } else {
                    openCount++;
                }
                totalCount++;
            }
        }
        const closedToday = closeCount - lastCloseCount;
        const openedToday = totalCount - lastTotalCount;
        dateLines.push([startDate.toLocaleDateString(), week, openCount, closeCount, closedToday, openedToday, openedToday - closedToday].join(","));
        
        startDate = new Date(+startDate + 1000 * 60 * 60 * 24);
        if (startDate.getDay() === 1) week++;
        lastCloseCount = closeCount;
        lastTotalCount = totalCount;
    }
    fs.writeFileSync("daily-journal.csv", dateLines.join("\r\n"), { encoding: "utf8" });
}

getPage(0, parse, false);
