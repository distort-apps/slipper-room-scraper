const { chromium } = require('playwright')
const fs = require('fs')

const endpoint = 'https://www.slipperroom.com/shows'

let gigzArr = []

const retry = async (fn, retries, delay) => {
  try {
    return await fn()
  } catch (error) {
    if (retries > 1) {
      await new Promise(resolve => setTimeout(resolve, delay))
      return retry(fn, retries - 1, delay)
    } else {
      throw error
    }
  }
}

const formatDateStringForMongoDB = dateString => {
  const currentYear = new Date().getFullYear()
  const date = new Date(`${dateString} ${currentYear}`)

  let isoString = date.toISOString()
  let datePart = isoString.split('T')[0]
  let timePart = '00:00:00.000'
  let timezoneOffset = '+00:00'

  return `${datePart}T${timePart}${timezoneOffset}`
}

const processExcerpt = (excerpt, link) => {
  let formattedExcerpt = ''

  if (excerpt) {
    formattedExcerpt += `<p>${excerpt}</p><br><br><ul><li><a href='${link}'>BUY TICKETS</a></li></ul>`
  }

  if (link && !excerpt) {
    formattedExcerpt += `<br><br><ul><li><a href='${link}'>BUY TICKETS</a></li></ul>`
  } else if (!link && !excerpt) {
    formattedExcerpt = ''
  }

  return formattedExcerpt
}

;(async () => {
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext()
  const page = await context.newPage()

  try {
    await page.goto(endpoint, { waitUntil: 'domcontentloaded' })

    let loadMoreButtonSelector = '.fgHLUq.evFet2'
    while (await page.$(loadMoreButtonSelector)) {
      await page.click(loadMoreButtonSelector)
      await page.waitForTimeout(2000) 
    }

    const ticketLinkSelector = 'a[data-hook="ev-rsvp-button"]'
    await page.waitForSelector(ticketLinkSelector, { timeout: 60000 })

    const eventLinks = await page.$$eval(ticketLinkSelector, elements =>
      elements.map(el => el.href)
    )
    console.log(`Collected ${eventLinks.length} event links`)

    for (const link of eventLinks) {
      const gigDetails = await scrapeEventDetails(context, link)
      if (gigDetails) gigzArr.push(gigDetails)
    }

    console.log(`Scraped ${gigzArr.length} event details`)
  } catch (error) {
    console.error('Error during the main process: ', error)
  } finally {
    await browser.close()

    if (gigzArr.length) {
      fs.writeFileSync('events.json', JSON.stringify(gigzArr, null, 2), 'utf-8')
      console.log('Data saved to events.json')
    } else {
      console.log('No data to save.')
    }
  }
})()

const scrapeEventDetails = async (context, link) => {
  let eventPage
  try {
    eventPage = await retry(
      async () => {
        return await context.newPage()
      },
      3,
      1000
    )

    await eventPage.goto(link, { waitUntil: 'domcontentloaded' })

    let title, date, genre, time, location, price, image, excerpt, isFeatured

    try {
      title = await eventPage.$eval('h1', el => el.textContent.trim())
    } catch (err) {
      console.error(`Error finding title on ${link}: `, err)
      title = null
    }

    try {
      date = await eventPage.$eval('p.W071OC', el => el.textContent.trim())
    } catch (err) {
      console.error(`Error finding date on ${link}: `, err)
      date = null
    }

    genre = 'Burlesque'

    location = 'The Slipper Room'

    try {
      excerpt = await eventPage.$eval('.vcrzUh.kMrkHS.D0_jh6.cn7Jfr', el =>
        el.textContent.trim()
      )
    } catch (err) {
      console.error(`Error finding excerpt on ${link}: `, err)
      excerpt = null
    }

    try {
        time = await eventPage.$eval('p[data-hook="event-full-date"]', el => {
          const dateText = el.textContent.trim();
          const timeMatch = dateText.match(/(\d{1,2}:\d{2}\s?[APMapm]{2})/);
          return timeMatch ? timeMatch[0] : null;
        });
      } catch (err) {
        console.error(`Error finding time on ${link}: `, err);
        time = null;
      }

    // Scrape prices
    let prices = [];
    try {
      prices = await eventPage.$$eval(
        'span.smrtOIr.oTg7_0d---typography-11-runningText.oTg7_0d---priority-7-primary',
        elements => elements.map(el => el.textContent.trim().replace('$', '').replace(',', ''))
      );

      // Filter out non-numeric values
      let priceNumbers = prices.filter(price => !isNaN(price)).map(price => parseFloat(price));

      if (priceNumbers.length === 1) {
        price = `$${priceNumbers[0]}`;
      } else {
        let minPrice = Math.min(...priceNumbers);
        let maxPrice = Math.max(...priceNumbers);

        if (!isNaN(minPrice) && !isNaN(maxPrice)) {
          price = `$${minPrice} - $${maxPrice}`;
        } else {
          price = 'Check details';
        }
      }
    } catch (err) {
      console.error(`Error finding prices on ${link}: `, err);
      price = 'Check details';
    }

    // Extract price from the excerpt if prices array is empty
    if (prices.length === 0) {
      const priceMatch = excerpt.match(/\$\d+(\.\d{1,2})?/g)
      if (priceMatch && priceMatch.length > 0) {
        price = priceMatch.join(' - ')
      }
    }

    try {
        image = await eventPage.$eval('.AO0uZW.rB2c3f[data-hook="event-image"] img', el => el.src);
      } catch (err) {
        console.error(`Error finding image on ${link}: `, err);
        image = null;
      }

    isFeatured = false

    await eventPage.close()
    date = formatDateStringForMongoDB(date)
    excerpt = processExcerpt(excerpt, link)

    return {
      title,
      date,
      genre,
      time,
      location,
      price,
      image,
      excerpt,
      isFeatured
    }
  } catch (error) {
    if (eventPage) {
      await eventPage.close()
    }
    console.error(`Error scraping details from ${link}: `, error)
    return null
  }
}
