let isWindowActivated, windowActivatedTime, messagesRemaining, maxMessages, capWindow, originalPlaceholder
let localDataSet = false

// semi-reliable way of determining if the page has fully loaded yet since window.onload fires too early
const resourceObserver = new PerformanceObserver((list) => {
  const entries = list.getEntries();

  for (const entry of entries) {
    // start trying to load data and inject the messages when the API polls for the conversation limit data
    if (entry.initiatorType === 'fetch' && entry.name === 'https://chat.openai.com/public-api/conversation_limit') {
      fetch(entry.name)
        .then(response => response.json())
        .then(data => {
          maxMessages = parseInt(data.message_cap)
          capWindow = parseInt(data.message_cap_window)

          setLocalDataFromStorage()

          // potentially update the message every second, relevant if fewer than 60 seconds remain in the window
          // also really ensure the send button events are added since they seemed to be missed when only called once
          setInterval( () => {
            registerSendButtonTracker()
            updateLimitMessage();
            }, 1000 );
        })
        .catch(/* don't break the page in case this the page or API fundamentally changes */);

      // no need to waste resources polling for resources if we already hit our load point
      resourceObserver.disconnect();
      break;
    }
  }
});

connectResourceObserver()

function connectResourceObserver()
{
  resourceObserver.observe({ entryTypes: ['resource'] });
}

function setLocalDataFromStorage() {
  chrome.storage.sync.get([
    'chatGPT4CapData.isWindowActivated',
    'chatGPT4CapData.windowActivatedTime',
    'chatGPT4CapData.messagesRemaining'
  ], (result) => {
    isWindowActivated = Boolean(result['chatGPT4CapData.isWindowActivated'] || false);
    windowActivatedTime = result['chatGPT4CapData.windowActivatedTime'] || null;
    messagesRemaining = parseInt(result['chatGPT4CapData.messagesRemaining'] || maxMessages);

    if (windowActivatedTime !== null) windowActivatedTime = parseInt(windowActivatedTime)
    localDataSet = true
  });
}

function getDivContaining(containingStr) {
  let deepestDiv = null;
  let deepestDepth = -1;

  function searchDiv(node, depth) {
    if (node.nodeName === 'DIV' && node.textContent.includes(containingStr)) {
      if (depth > deepestDepth) {
        deepestDiv = node;
        deepestDepth = depth;
      }
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      searchDiv(node.childNodes[i], depth + 1);
    }
  }

  searchDiv(document.body, 0);

  return deepestDiv;
}

function updateLimitMessage() {
  if (!localDataSet) {
    return
  }

  const isValidWindowActivatedTime = windowActivatedTime !== null && !isNaN(windowActivatedTime)
  let hoursRemaining, minutesRemaining, secondsRemaining

  if (isValidWindowActivatedTime) {
    const windowEndTime = windowActivatedTime + (capWindow * 60)
    secondsRemaining = windowEndTime - Math.floor(Date.now() / 1000)
    hoursRemaining = Math.floor(secondsRemaining / 3600)
    minutesRemaining = Math.floor(secondsRemaining % 3600 / 60)
  }

  let message = 'You have not activated your cap window yet.';

  if (secondsRemaining < 0) {
    if (isWindowActivated) {
      isWindowActivated = false
      messagesRemaining = maxMessages

      chrome.storage.sync.set({
        'chatGPT4CapData.isWindowActivated': isWindowActivated,
        'chatGPT4CapData.windowActivatedTime': null,
        'chatGPT4CapData.messagesRemaining': messagesRemaining
      });
    }
  }

  if (isValidWindowActivatedTime && isWindowActivated) {
    const remainingTimeMessage = secondsRemaining >= 60
      ? `${hoursRemaining} hours and ${minutesRemaining} minutes`
      : `${secondsRemaining} seconds`

    message = `You have ${messagesRemaining} remaining. Your limit will reset in ${remainingTimeMessage}.`;
  }

  const limitMessageDiv = getDivContaining('GPT-4 currently has a cap of')

  if (limitMessageDiv !== null) {
    // this will add the limit cap info to the footnote warning in a new conversation
    updateMessageFootnote(limitMessageDiv, message)
    // remove any potentially rendered prompt once/if this has loaded so we don't display double message
    updateMessagePlaceholder(message, true)
  } else {
    // this will add the limit cap info to the placeholder text in the prompt field of an ongoing conversation
    updateMessagePlaceholder(message)
  }
}

function updateMessageFootnote(limitMessageDiv, message)
{
  let capInfoSpan = document.getElementById('cap-info-span');

  if (!capInfoSpan) {
    capInfoSpan = document.createElement('span');
    capInfoSpan.id = 'cap-info-span';
    limitMessageDiv.appendChild(capInfoSpan);
  }

  capInfoSpan.textContent = isGpt4() ? `\n${message}` : '';
}

function updateMessagePlaceholder(message, reset = false)
{
  let prompt = document.getElementById('prompt-textarea');
  if (prompt === null) return
  if (!originalPlaceholder) originalPlaceholder = prompt.placeholder

  prompt.placeholder = isGpt4() && !reset ? `${originalPlaceholder}. ${message}` : originalPlaceholder
}

function registerSendButtonTracker() {
  const inputField = document.getElementById('prompt-textarea')
  const button = inputField.nextElementSibling

  const element = document.getElementById('div');
  if (button && !button.hasAttribute('listenerOnClick')) {
    button.addEventListener('click', onMessageSent);
    button.setAttribute('listenerOnClick', 'true');
  }

  // cover the case when we send a message via Enter instead of clicking the button
  if (inputField && !inputField.hasAttribute('listenerOnClick')) {
    inputField.addEventListener('keyup', (event) => {
      if (['Enter', 'NumpadEnter'].includes(event.key) && !event.shiftKey) {
        onMessageSent()
      }
    });

    inputField.setAttribute('listenerOnClick', 'true');
  }
}

function onMessageSent() {
  if (!isGpt4()) {
    return
  }

  if (!isWindowActivated) {
    isWindowActivated = true;
    windowActivatedTime = Math.floor(Date.now() / 1000);
    messagesRemaining = maxMessages - 1;
  } else {
    messagesRemaining -= 1;
  }

  chrome.storage.sync.set({
    'chatGPT4CapData.isWindowActivated': isWindowActivated,
    'chatGPT4CapData.windowActivatedTime': windowActivatedTime,
    'chatGPT4CapData.messagesRemaining': messagesRemaining
  });

  updateLimitMessage();
}

function isGpt4()
{
  if (window.location.href === 'https://chat.openai.com/?model=gpt-4') {
    return true
  }

  if (window.location.href.startsWith('https://chat.openai.com/c/')) {
    const modelDiv = getDivContaining('Model:')
    if (modelDiv === null) return false // edge case page not properly loaded yet
    const model = modelDiv.textContent.substring(modelDiv.textContent.indexOf('Model: ') + 7);

    return model === 'GPT-4'
  }

  return false
}

const observeUrlChange = () => {
  let oldHref = document.location.href;
  const body = document.querySelector('body');
  const urlObserver = new MutationObserver(() => {
    if (oldHref !== document.location.href) {
      oldHref = document.location.href;
      connectResourceObserver()
    }
  });

  urlObserver.observe(body, { childList: true, subtree: true });
};

window.onload = observeUrlChange;