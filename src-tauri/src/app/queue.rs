//! The message queue of a chat: what the user typed while the agent was working.
//!
//! The queue lives here, not in the window, so it keeps going when the user looks at another
//! chat. When a turn ends well the next message goes out; when it was stopped or failed the
//! queue waits, because whoever pressed Stop did not mean "and carry on with the rest".
//! "Send now" is the way past that: it stops the running turn and puts that message first.

use std::collections::VecDeque;

use crate::domain::ids::SessionId;
use crate::domain::image::decode_uploads;
use crate::domain::{
    Error, ErrorCode, ImageUpload, InsightEvent, MessageQueue, QueuedMessage, Result, SessionKind,
    SessionStatus,
};

use super::engine::Engine;

/// What the engine keeps for one chat.
#[derive(Default)]
pub(crate) struct QueueState {
    items: VecDeque<Entry>,
    paused: bool,
    /// The first message was asked for by name: it goes out when the running turn ends, however
    /// that turn ends.
    force: bool,
}

/// A queued message with its pictures, which the window sent once and does not hold.
#[derive(Clone)]
struct Entry {
    id: String,
    text: String,
    images: Vec<ImageUpload>,
}

impl Entry {
    fn view(&self) -> QueuedMessage {
        QueuedMessage {
            id: self.id.clone(),
            text: self.text.clone(),
            images: self.images.iter().map(|image| image.name.clone()).collect(),
        }
    }
}

impl QueueState {
    fn view(&self) -> MessageQueue {
        MessageQueue {
            items: self.items.iter().map(Entry::view).collect(),
            paused: self.paused,
        }
    }
}

/// What happened when a queued message was handed to the agent.
enum Dispatch {
    Sent,
    /// The agent started something else first (a BTW report, say); the next turn end retries.
    Busy,
}

impl Engine {
    pub fn queue(&self, session_id: SessionId) -> MessageQueue {
        self.queues
            .lock()
            .get(&session_id)
            .map(QueueState::view)
            .unwrap_or_default()
    }

    /// Adds a message to the end of the queue. If the agent turned out to be free already, it
    /// goes out at once.
    pub fn enqueue(
        &self,
        session_id: SessionId,
        text: &str,
        images: Vec<ImageUpload>,
    ) -> Result<MessageQueue> {
        let text = text.trim();
        if text.is_empty() && images.is_empty() {
            return Err(Error::new(ErrorCode::Invalid, "message is empty"));
        }
        // A picture that cannot be sent is refused now, not when its turn comes.
        decode_uploads(&images)?;
        if self.session(session_id)?.kind != SessionKind::Chat {
            return Err(Error::new(ErrorCode::Invalid, "only chats have a queue"));
        }
        let view = {
            let mut queues = self.queues.lock();
            let state = queues.entry(session_id).or_default();
            state.items.push_back(Entry {
                id: uuid::Uuid::new_v4().to_string(),
                text: text.to_string(),
                images,
            });
            state.view()
        };
        self.emit_queue(session_id, view);
        if !self.is_working(session_id) {
            self.queue_advance(session_id, true);
        }
        Ok(self.queue(session_id))
    }

    pub fn queue_remove(&self, session_id: SessionId, id: &str) -> MessageQueue {
        let view = {
            let mut queues = self.queues.lock();
            let Some(state) = queues.get_mut(&session_id) else {
                return MessageQueue::default();
            };
            state.items.retain(|item| item.id != id);
            if state.items.is_empty() {
                queues.remove(&session_id);
                MessageQueue::default()
            } else {
                state.view()
            }
        };
        self.emit_queue(session_id, view.clone());
        view
    }

    /// Sends one queued message now: the running turn is stopped and this message goes next,
    /// ahead of the rest. With no turn running it simply goes out.
    pub fn queue_send_now(&self, session_id: SessionId, id: &str) -> Result<MessageQueue> {
        let working = self.is_working(session_id);
        let view = {
            let mut queues = self.queues.lock();
            let state = queues
                .get_mut(&session_id)
                .ok_or_else(|| Error::new(ErrorCode::NotFound, "that message is not queued"))?;
            let position = state
                .items
                .iter()
                .position(|item| item.id == id)
                .ok_or_else(|| Error::new(ErrorCode::NotFound, "that message is not queued"))?;
            if let Some(item) = state.items.remove(position) {
                state.items.push_front(item);
            }
            state.force = true;
            state.paused = false;
            state.view()
        };
        self.emit_queue(session_id, view);

        if working {
            self.runtime.cancel(&session_id, None)?;
        }
        // Either nothing was running, or the turn ended between the check and the stop and no
        // end is coming to wake the queue.
        if !self.is_working(session_id) {
            self.queue_send_next(session_id)?;
        }
        Ok(self.queue(session_id))
    }

    /// A chat's turn ended: send the next message, or hold the queue if the turn did not end
    /// well.
    pub(crate) fn queue_advance(&self, session_id: SessionId, ok: bool) {
        {
            let mut queues = self.queues.lock();
            let Some(state) = queues.get_mut(&session_id) else {
                return;
            };
            if state.items.is_empty() {
                queues.remove(&session_id);
                return;
            }
            if !ok && !state.force {
                if state.paused {
                    return;
                }
                state.paused = true;
                let view = state.view();
                drop(queues);
                self.emit_queue(session_id, view);
                return;
            }
        }
        if let Err(error) = self.queue_send_next(session_id) {
            eprintln!("ataraxia: could not send the next queued message: {error}");
        }
    }

    /// Hands the first message to the agent. On failure the message stays and the queue holds.
    fn queue_send_next(&self, session_id: SessionId) -> Result<()> {
        let Some(item) = self
            .queues
            .lock()
            .get(&session_id)
            .and_then(|state| state.items.front().cloned())
        else {
            return Ok(());
        };
        match self.dispatch(session_id, &item) {
            Ok(Dispatch::Sent) => {
                let view = {
                    let mut queues = self.queues.lock();
                    let Some(state) = queues.get_mut(&session_id) else {
                        return Ok(());
                    };
                    state.items.retain(|queued| queued.id != item.id);
                    state.force = false;
                    state.paused = false;
                    if state.items.is_empty() {
                        queues.remove(&session_id);
                        MessageQueue::default()
                    } else {
                        state.view()
                    }
                };
                self.emit_queue(session_id, view);
                Ok(())
            }
            Ok(Dispatch::Busy) => Ok(()),
            Err(error) => {
                let view = {
                    let mut queues = self.queues.lock();
                    queues.get_mut(&session_id).map(|state| {
                        state.force = false;
                        state.paused = true;
                        state.view()
                    })
                };
                if let Some(view) = view {
                    self.emit_queue(session_id, view);
                }
                Err(error)
            }
        }
    }

    fn dispatch(&self, session_id: SessionId, item: &Entry) -> Result<Dispatch> {
        // Marking the turn start while another turn runs would blur what each one changed.
        if self.is_working(session_id) {
            return Ok(Dispatch::Busy);
        }
        self.turn_started(session_id);
        match self
            .runtime
            .prompt_with_images(&session_id, &item.text, item.images.clone())
        {
            Ok(_) => Ok(Dispatch::Sent),
            Err(error) if error.message.contains("already running") => Ok(Dispatch::Busy),
            Err(error) => Err(error),
        }
    }

    fn is_working(&self, session_id: SessionId) -> bool {
        matches!(
            self.runtime.status(&session_id),
            Ok(SessionStatus::Working | SessionStatus::WaitingPermission)
        )
    }

    fn emit_queue(&self, session_id: SessionId, queue: MessageQueue) {
        self.sink
            .emit_insight(InsightEvent::Queue { session_id, queue });
    }
}
