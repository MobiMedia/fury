# Fury Rendering Server

Fury is a Node.js wrapper for the [Puppeteer](https://github.com/puppeteer/puppeteer) `screenshot` and `pdf` function.

You can `POST` to `/screenshot` or `/pdf` to create either a screenshot or generate a pdf from a given URL.
All parameters have to be sent in the `POST` body and they have to be in JSON syntax.

Unless `renderEventName` isn't set, Fury will wait for the screenshot or pdf creation until no network request is
made for at least 500 milliseconds.

All given parameters will be forwarded to the target page via the `FURY_PARAMS` object in the `window` object of the browser.

## Environment Settings
There are several environment variables which Fury is using:
- `DEBUG`: If `DEBUG=1`, Fury will open the browser not in headless mode and open the development tools in each browser.
- `CONCURRENT_LIMIT`: Defines the amount of max. concurrent rendering processes. Default is one concurrent rendering.
- `TIMEOUT`: Defines the timeout for all requests in milliseconds. Default: 30000 (30 seconds)
- `PROTOCOLTIMEOUT`: Defines the protocolTimeout in puppeteer

## Request
### Take a screenshot
`/screenshot`

#### Available Parameters
- `url` (**Required**): The URL to the target page for the screenshot
- `width`: Width in pixel of the resulting image. Default: 1920.
- `height`: Height in pixel of the resulting image. Default: 1080.
- `cookies`: Cookies which will be set before taking the screenshot. You can find a detailed explanation below.
- `renderEventName`: The RenderFunctionName. You can find a detailed explanation below.

#### Example
```shell script
curl --location --request POST 'http://localhost:3000/screenshot' \
--header 'Content-Type: application/json' \
--data-raw '{
    "url": "https://google.com",
    "width": 800,
    "height": 800,
    "timeout": 60000,
    "cookies": {
        "cookie1": "value1"
    }
}'
```

This request will set the cookie named `cookie` with `value1` and take a screenshot from `https://google.com` with dimensions of 800px x 800px.
The `POST` will fail if the page doesn't respond after 60 seconds.

---

## Create a PDF
`/pdf`
Creates a PDF of the given page by simulating a printout.

#### Available Parameters
- `url` (**Required**): The URL to the target page for the screenshot
- `width`: Width of the page. If `format` is defined, this will be ignored. This parameter will be forwarded to Puppeteer, so you can find a detailed explanation [here](https://github.com/puppeteer/puppeteer/blob/v5.2.1/docs/api.md#pagepdfoptions).
- `height`: Height of the page. If `format` is defined, this will be ignored. This parameter will be forwarded to Puppeteer, so you can find a detailed explanation [here](https://github.com/puppeteer/puppeteer/blob/v5.2.1/docs/api.md#pagepdfoptions).
- `format`: Format of the page. This parameter will be forwarded to Puppeteer, so you can find a detailed explanation [here](https://github.com/puppeteer/puppeteer/blob/v5.2.1/docs/api.md#pagepdfoptions).
- `cookies`: Cookies which will be set before taking the screenshot. You can find a detailed explanation below.
- `renderEventName`: The RenderFunctionName. You can find a detailed explanation below.
- `renderEventNameTimeout`: The timeout in milliseconds for waiting to call `renderEventName`. If not specified, the default Timeout of the Fury Application will be used. Must be smaller than the global Request Timeout
- `printBackground`: Include background media in the pdf ? This parameter will be forwarded to Puppeteer, so you can find a detailed explanation [here](https://github.com/puppeteer/puppeteer/blob/v5.2.1/docs/api.md#pagepdfoptions).
- `landscape`: Is the page landscape orientated ? Only works, if `format` is provided. This parameter will be forwarded to Puppeteer, so you can find a detailed explanation [here](https://github.com/puppeteer/puppeteer/blob/v5.2.1/docs/api.md#pagepdfoptions).
- `margin`: Margin for the printout. This parameter will be forwarded to Puppeteer, so you can find a detailed explanation [here](https://github.com/puppeteer/puppeteer/blob/v5.2.1/docs/api.md#pagepdfoptions).

#### Example
```shell script
curl --location --request POST 'http://localhost:3000/pdf' \
--header 'Content-Type: application/json' \
--data-raw '{
    "url": "https://google.com",
    "format": "A4",
    "printBackground":  true,
    "landscape": true,
    "cookies": {
        "cookie1": "value1"
    }
}
```

This request will create a pdf by simulating a printout of `https://google.com`. The page size in the pdf is `A4` in landscape mode. Additionally, Fury will set the cookie `cookie1` with the value `value`.

---

## Defining Required Cookies
Both methods supports the `cookies` parameter to define some required cookies to process the page.
This can be used for example to take a screenshot of a page which requires a login cookie.

The syntax is pretty straight forward. You define the cookies in JSON syntax, where the key represents the cookie name and the value is the value of the cookie.
Syntax: 
   ```json
  {
    "cookiename1": "cookievalue1",
    "cookiename2": "cookievalue2"
  } 
  ```

## RenderEventName
If the target page have to do some work before the page is ready for the screenshot, you can define with the `renderEventName` parameter a function name for which
Fury will wait. The function name will be exposed to the global `window` object of the browser. After calling the function from the target page, the screenshot or the pdf
will be created unless the `timeout` expires before.

## Page errors
A page can provide an error message which will be considered after page navigation.
To provide an error message, just create a `<div class="furyError">` on the page and fill it with the error message if you don't want to print the page.

If this div exists and has a content, the content of the div will be returned as `error`.

## Response
After processing the target page, Fury will send a response in JSON syntax:
```json
{
  "data": "",
  "error": ""
}
```

`data`: The image or pdf encoded via base64 or null, if an error occured.

`error`: If an error occured, this will contain the error message and call stack of the error. Otherwise null.

### MessagePack
If the HTTP request has the string `msgpack` in the HTTP `Accept:` header, Fury will return the same response as a [MessagePack](https://msgpack.org/) map. Because MessagePack allows binary data, this is more efficient because the data doesn't have to be encoded to base64 and it allows to return larger files.
