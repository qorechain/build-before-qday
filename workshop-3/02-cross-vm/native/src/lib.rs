//! qday-receipts: a receipt book on the QoreChain Native lane.
//!
//! Anyone can add a receipt. The contract records who sent it (`sender`).
//! When an EVM contract calls it through the CrossVM bridge (0x...0901), the
//! sender is that EVM contract's own account, so the receipt shows which
//! contract on the other VM wrote it.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_json_binary, Addr, Binary, Deps, DepsMut, Env, MessageInfo, Order, Response,
    StdResult,
};
use cw_storage_plus::{Item, Map};
use thiserror::Error;

pub const MAX_NOTE: usize = 140;

#[cw_serde]
pub struct Receipt {
    pub id: u64,
    pub sender: Addr,
    pub note: String,
    pub height: u64,
}

#[cw_serde]
pub struct InstantiateMsg {}

#[cw_serde]
pub enum ExecuteMsg {
    /// Add a receipt with a short note (1 to 140 characters).
    Record { note: String },
    /// Always fails. Used to show that a failure on the Native side undoes
    /// the whole transaction, EVM side included.
    Fail {},
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(CountResponse)]
    Count {},
    #[returns(Receipt)]
    Receipt { id: u64 },
    /// The latest receipts, newest first (at most 20).
    #[returns(ReceiptsResponse)]
    Latest { limit: Option<u32> },
}

#[cw_serde]
pub struct CountResponse {
    pub count: u64,
}

#[cw_serde]
pub struct ReceiptsResponse {
    pub receipts: Vec<Receipt>,
}

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),
    #[error("the note must be 1 to {MAX_NOTE} characters")]
    BadNote,
    #[error("refused on purpose by the Native contract")]
    Refused,
}

const COUNT: Item<u64> = Item::new("count");
const RECEIPTS: Map<u64, Receipt> = Map::new("receipts");

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(deps: DepsMut, _env: Env, _info: MessageInfo, _msg: InstantiateMsg) -> StdResult<Response> {
    COUNT.save(deps.storage, &0)?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(deps: DepsMut, env: Env, info: MessageInfo, msg: ExecuteMsg) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Record { note } => {
            let note = note.trim().to_string();
            if note.is_empty() || note.chars().count() > MAX_NOTE {
                return Err(ContractError::BadNote);
            }
            let id = COUNT.load(deps.storage)? + 1;
            let receipt = Receipt { id, sender: info.sender.clone(), note, height: env.block.height };
            RECEIPTS.save(deps.storage, id, &receipt)?;
            COUNT.save(deps.storage, &id)?;
            Ok(Response::new()
                .add_attribute("action", "record")
                .add_attribute("id", id.to_string())
                .add_attribute("sender", info.sender)
                .set_data(to_json_binary(&receipt)?))
        }
        ExecuteMsg::Fail {} => Err(ContractError::Refused),
    }
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Count {} => to_json_binary(&CountResponse { count: COUNT.load(deps.storage)? }),
        QueryMsg::Receipt { id } => to_json_binary(&RECEIPTS.load(deps.storage, id)?),
        QueryMsg::Latest { limit } => {
            let n = limit.unwrap_or(10).min(20) as usize;
            let receipts = RECEIPTS
                .range(deps.storage, None, None, Order::Descending)
                .take(n)
                .map(|r| r.map(|(_, v)| v))
                .collect::<StdResult<Vec<_>>>()?;
            to_json_binary(&ReceiptsResponse { receipts })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env};
    use cosmwasm_std::from_json;

    #[test]
    fn records_and_counts() {
        let mut deps = mock_dependencies();
        let alice = deps.api.addr_make("alice");
        instantiate(deps.as_mut(), mock_env(), message_info(&alice, &[]), InstantiateMsg {}).unwrap();
        execute(deps.as_mut(), mock_env(), message_info(&alice, &[]), ExecuteMsg::Record { note: " hi ".into() }).unwrap();
        let c: CountResponse = from_json(query(deps.as_ref(), mock_env(), QueryMsg::Count {}).unwrap()).unwrap();
        assert_eq!(c.count, 1);
        let r: Receipt = from_json(query(deps.as_ref(), mock_env(), QueryMsg::Receipt { id: 1 }).unwrap()).unwrap();
        assert_eq!(r.note, "hi");
        assert_eq!(r.sender, alice);
    }

    #[test]
    fn refuses_bad_notes_and_fail() {
        let mut deps = mock_dependencies();
        let a = deps.api.addr_make("a");
        instantiate(deps.as_mut(), mock_env(), message_info(&a, &[]), InstantiateMsg {}).unwrap();
        let long = "x".repeat(MAX_NOTE + 1);
        assert_eq!(execute(deps.as_mut(), mock_env(), message_info(&a, &[]), ExecuteMsg::Record { note: long }).unwrap_err(), ContractError::BadNote);
        assert_eq!(execute(deps.as_mut(), mock_env(), message_info(&a, &[]), ExecuteMsg::Record { note: "  ".into() }).unwrap_err(), ContractError::BadNote);
        assert_eq!(execute(deps.as_mut(), mock_env(), message_info(&a, &[]), ExecuteMsg::Fail {}).unwrap_err(), ContractError::Refused);
    }

    #[test]
    fn latest_is_newest_first() {
        let mut deps = mock_dependencies();
        let a = deps.api.addr_make("a");
        instantiate(deps.as_mut(), mock_env(), message_info(&a, &[]), InstantiateMsg {}).unwrap();
        for i in 0..3 {
            execute(deps.as_mut(), mock_env(), message_info(&a, &[]), ExecuteMsg::Record { note: format!("n{i}") }).unwrap();
        }
        let l: ReceiptsResponse = from_json(query(deps.as_ref(), mock_env(), QueryMsg::Latest { limit: Some(2) }).unwrap()).unwrap();
        assert_eq!(l.receipts.iter().map(|r| r.id).collect::<Vec<_>>(), vec![3, 2]);
    }
}
