import axios from 'axios';

const AGENT_URL = 'http://localhost:8000';

export const triggerAgent = async (inputData, files) => {
  try {
    const response = await axios.post(`${AGENT_URL}/analyze`, {
      text: inputData,
      metadata: { timestamp: new Date().toISOString() },
      files: files && files.length ? files : undefined,
    });
    return response.data;
  } catch (error) {
    console.error('Agent communication failure', error);
    throw error;
  }
};

export const fetchPrices = async () => {
  const response = await axios.get(`${AGENT_URL}/prices`);
  return response.data;
};

export const createCheckoutSession = async (tier, origin) => {
  const response = await axios.post(`${AGENT_URL}/create-checkout-session`, { tier, origin });
  return response.data;
};

export const analyzePaid = async (sessionId, text, tier, files) => {
  const response = await axios.post(`${AGENT_URL}/analyze-paid`, {
    session_id: sessionId,
    text,
    tier,
    files: files && files.length ? files : undefined,
  });
  return response.data;
};
